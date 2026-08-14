/**
 * Download-integrity helpers (RC-E).
 *
 * Two concerns live here:
 *   1. Content verification — `computeSha256` / `verifySha256` stream a file
 *      off disk and hard-throw on a checksum mismatch. Used to gate any
 *      downloaded artifact that carries a KNOWN-GOOD pinned hash (models,
 *      and — once a binary is re-hosted + pinned — binaries too).
 *   2. Transport hardening — `fetchWithHttpsOnlyRedirects` follows redirects
 *      manually and REFUSES any hop that downgrades to plain `http:`. This is
 *      the ONLY MITM mitigation for artifacts whose download URL is a moving
 *      "latest" alias and therefore cannot carry a static sha256 (a pinned
 *      hash on a moving URL would brick first boot the instant upstream
 *      updates). GitHub / evermeet / johnvansickle all 3xx-redirect to CDNs;
 *      we allow that as long as every hop stays HTTPS.
 *
 * Server-only (uses `node:crypto` + `node:fs`).
 */

import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { looksUnreachable } from "@/lib/runtime/network-errors";

/**
 * Stream `filePath` and return its lowercase hex sha256.
 * Rejects (ENOENT) when the file does not exist.
 */
export async function computeSha256(filePath: string): Promise<string> {
  // stat first so a missing file surfaces a clear ENOENT instead of an
  // empty-hash false-positive.
  await stat(filePath);
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex").toLowerCase()));
  });
}

/**
 * Verify `filePath` matches `expected` (case-insensitive hex sha256).
 * Throws an actionable Error on mismatch (path + expected-prefix +
 * actual-prefix) or when the file is missing.
 */
export async function verifySha256(
  filePath: string,
  expected: string,
): Promise<void> {
  const want = expected.trim().toLowerCase();
  const actual = await computeSha256(filePath);
  if (actual !== want) {
    throw new Error(
      `sha256 mismatch for ${filePath}: expected ${want.slice(0, 16)}…, ` +
        `got ${actual.slice(0, 16)}… — refusing to install a tampered/corrupt artifact.`,
    );
  }
}

const MAX_REDIRECTS = 10;

/**
 * `fetch` a URL, following 3xx redirects MANUALLY and rejecting any hop that
 * is not HTTPS. Prevents an on-path attacker from redirecting a download to a
 * plaintext `http:` endpoint they control (DNS-rebinding / MITM downgrade).
 *
 * The caller's `init` is passed through; `redirect` is forced to `"manual"`
 * so each hop is inspected. Returns the final non-redirect Response (body
 * intact for streaming). A 3xx with no `Location` header is handed back as-is.
 */
export async function fetchWithHttpsOnlyRedirects(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  // NB: `init.signal` (when provided) rides through to every hop's fetch —
  // `downloadBufferWithStallGuard` relies on this to abort a hung redirect
  // chain or header wait, not just a hung body stream.
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      throw new Error(`Invalid download URL: ${current}`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(
        `Refusing to download over a non-HTTPS URL (possible MITM downgrade): ${current}`,
      );
    }

    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;
      const next = new URL(location, current);
      if (next.protocol !== "https:") {
        throw new Error(
          `Refusing to follow an HTTPS→${next.protocol.replace(":", "")} redirect ` +
            `downgrade (${current} → ${next.href}) — aborting download.`,
        );
      }
      current = next.href;
      continue;
    }
    return res;
  }
  throw new Error(
    `Too many redirects (>${MAX_REDIRECTS}) while downloading ${url}`,
  );
}

// ---------------------------------------------------------------------------
// Stall-guarded downloading (task #54 — packaged app hung forever on a
// dependency download whose socket went ESTABLISHED-but-silent).
//
// Design: an IDLE deadline, not a total deadline. A genuinely slow 65MB
// download on bad hotel wifi must SUCCEED; a download that produces zero
// bytes for `idleTimeoutMs` must FAIL FAST. The idle timer is re-armed on
// every chunk that arrives, and it also covers the pre-header phase (DNS,
// connect, redirect chain, time-to-first-byte) because the AbortSignal is
// passed into the fetch itself.
//
// On failure the attempt is retried with bounded backoff; the FINAL error
// names the host, the URL, the bytes received vs expected, and the
// dependency — following `lib/runtime/network-errors.ts`'s "name the host"
// principle (and deliberately containing the phrase "network timeout" so
// `looksUnreachable()` classifies it into the network-hint branch of
// `binaryInstallHints`).
// ---------------------------------------------------------------------------

/** Default idle deadline: abort when NO bytes arrive for this long. */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
/** Default total attempts (first try + retries). */
export const DOWNLOAD_MAX_ATTEMPTS = 3;
/** Default delay before attempt 2, then attempt 3+ (last entry repeats). */
export const DOWNLOAD_RETRY_BACKOFF_MS: readonly number[] = [1_000, 4_000];

function fmtMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Flatten `err.message` plus its `cause` chain (undici wraps the real
 *  ECONNRESET/ETIMEDOUT inside `TypeError: fetch failed`). */
function messageWithCauses(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth++) {
    if (cur instanceof Error) {
      parts.push(cur.message);
      cur = cur.cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(": ");
}

/** The idle deadline fired: the connection produced no bytes for the whole
 *  window. Message contains "network timeout" on purpose — see module note. */
export class DownloadStalledError extends Error {
  readonly url: string;
  readonly host: string;
  readonly bytesDownloaded: number;
  readonly bytesTotal: number | null;
  readonly idleTimeoutMs: number;

  constructor(opts: {
    url: string;
    bytesDownloaded: number;
    bytesTotal: number | null;
    idleTimeoutMs: number;
  }) {
    const host = hostOf(opts.url);
    const got = fmtMb(opts.bytesDownloaded);
    const of = opts.bytesTotal != null ? ` of ${fmtMb(opts.bytesTotal)}` : "";
    super(
      `no data received for ${Math.round(opts.idleTimeoutMs / 1000)}s ` +
        `(network timeout — connection to ${host} stalled at ${got}${of})`,
    );
    this.name = "DownloadStalledError";
    this.url = opts.url;
    this.host = host;
    this.bytesDownloaded = opts.bytesDownloaded;
    this.bytesTotal = opts.bytesTotal;
    this.idleTimeoutMs = opts.idleTimeoutMs;
  }
}

/** Non-2xx terminal response. Retryable only for 5xx / 408 / 429. */
export class DownloadHttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, statusText: string, url: string) {
    super(`Download failed: HTTP ${status} ${statusText} fetching ${url}`);
    this.name = "DownloadHttpError";
    this.status = status;
    this.url = url;
  }
}

/**
 * Terminal give-up error after all attempts. The message is the actionable
 * one the splash / CLI fatal block shows: host, url, dependency label,
 * attempts, bytes received vs expected, and the last underlying error.
 */
export class DownloadFailedError extends Error {
  readonly url: string;
  readonly host: string;
  readonly label: string | undefined;
  readonly attempts: number;
  readonly bytesDownloaded: number;
  readonly bytesTotal: number | null;
  readonly lastError: Error;

  constructor(opts: {
    url: string;
    label?: string;
    attempts: number;
    bytesDownloaded: number;
    bytesTotal: number | null;
    lastError: Error;
  }) {
    const host = hostOf(opts.url);
    const what = opts.label ? `"${opts.label}"` : "artifact";
    const got = fmtMb(opts.bytesDownloaded);
    const of = opts.bytesTotal != null ? ` of ${fmtMb(opts.bytesTotal)} expected` : "";
    const tries =
      opts.attempts === 1 ? "1 attempt" : `${opts.attempts} attempts`;
    super(
      `Download of ${what} from ${host} failed after ${tries}: ` +
        `${opts.lastError.message} — received ${got}${of}. URL: ${opts.url}`,
    );
    this.name = "DownloadFailedError";
    this.url = opts.url;
    this.host = host;
    this.label = opts.label;
    this.attempts = opts.attempts;
    this.bytesDownloaded = opts.bytesDownloaded;
    this.bytesTotal = opts.bytesTotal;
    this.lastError = opts.lastError;
  }
}

export interface DownloadRetryInfo {
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  maxAttempts: number;
  /** How long we sleep before the next attempt. */
  delayMs: number;
  error: Error;
  bytesDownloaded: number;
  bytesTotal: number | null;
}

export interface StallGuardedDownloadOptions {
  /** Human name of the thing being downloaded (dependency/binary), for errors. */
  label?: string;
  /** Abort an attempt when no bytes arrive for this long. Env override:
   *  `LIBI_DOWNLOAD_IDLE_TIMEOUT_MS`. Default 30s. */
  idleTimeoutMs?: number;
  /** Total attempts including the first. Env override:
   *  `LIBI_DOWNLOAD_MAX_ATTEMPTS`. Default 3. */
  maxAttempts?: number;
  /** Delay before attempt n+1 (last entry repeats for later attempts). */
  backoffMs?: readonly number[];
  /** Byte-level progress, forwarded per chunk. */
  onProgress?: (p: { bytesDownloaded: number; bytesTotal: number | null }) => void;
  /** Fired before each retry sleep — surface this to the log/splash. */
  onRetry?: (info: DownloadRetryInfo) => void;
  /** Transport; defaults to `fetchWithHttpsOnlyRedirects`. Injectable so unit
   *  tests can stream from a local plain-HTTP server without weakening the
   *  production HTTPS-only enforcement. */
  doFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

function envInt(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Should this failed attempt be retried? Stalls, transport-level failures,
 *  and transient HTTP statuses — yes. 404s, HTTPS-downgrade refusals, sha
 *  mismatches and other permanent errors — no. */
function isRetryableDownloadError(err: unknown): boolean {
  if (err instanceof DownloadStalledError) return true;
  if (err instanceof DownloadHttpError) {
    return err.status >= 500 || err.status === 408 || err.status === 429;
  }
  const msg = messageWithCauses(err);
  if (looksUnreachable(msg)) return true;
  // undici's generic wrapper + premature stream terminations.
  return /fetch failed|terminated|premature close|ERR_STREAM_PREMATURE_CLOSE|UND_ERR_(?!ABORTED)/i.test(
    msg,
  );
}

/** Per-attempt handle given to a consumer of the guarded download loop. */
export interface GuardedAttemptContext {
  /** Re-arm the idle deadline. MUST be called for every chunk that arrives —
   *  that is what distinguishes "slow but alive" from "stalled". */
  arm(): void;
  /** Record bytes received, so `onProgress` and the give-up error are honest. */
  bump(n: number): void;
  /** `content-length` when the server sent one, else null. */
  bytesTotal: number | null;
}

/**
 * The shared stall-guard + bounded-retry scaffolding.
 *
 * Both public download helpers run through this ONE loop on purpose. The bug
 * this guards against (#54) was fixed in the dependency-manager path while the
 * tracking-installer path kept its own bare `fetch` — so the second copy of
 * "download a file" silently lacked every protection the first one gained.
 * Duplicating the retry loop here would rebuild that exact trap; a consumer
 * callback keeps memory strategy (buffer vs stream-to-disk) as the ONLY
 * difference between them.
 */
async function runGuardedDownload<T>(
  url: string,
  options: StallGuardedDownloadOptions,
  consume: (res: Response, ctx: GuardedAttemptContext) => Promise<T>,
): Promise<T> {
  const idleTimeoutMs =
    options.idleTimeoutMs ??
    envInt("LIBI_DOWNLOAD_IDLE_TIMEOUT_MS") ??
    DOWNLOAD_IDLE_TIMEOUT_MS;
  const maxAttempts =
    options.maxAttempts ??
    envInt("LIBI_DOWNLOAD_MAX_ATTEMPTS") ??
    DOWNLOAD_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? DOWNLOAD_RETRY_BACKOFF_MS;
  const doFetch = options.doFetch ?? fetchWithHttpsOnlyRedirects;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // Shared across attempts so the final error can report the best-known
  // bytesTotal even when the last attempt died before headers.
  let lastKnownTotal: number | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let bytesDownloaded = 0;
    const controller = new AbortController();
    let stalled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, idleTimeoutMs);
    };

    try {
      arm();
      const res = await doFetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new DownloadHttpError(res.status, res.statusText, res.url || url);
      }
      const contentLength = res.headers.get("content-length");
      const bytesTotal = contentLength ? parseInt(contentLength, 10) : null;
      if (bytesTotal != null) lastKnownTotal = bytesTotal;

      const ctx: GuardedAttemptContext = {
        arm,
        bump(n: number) {
          bytesDownloaded += n;
          options.onProgress?.({ bytesDownloaded, bytesTotal });
        },
        bytesTotal,
      };
      return await consume(res, ctx);
    } catch (rawErr) {
      const err: Error = stalled
        ? new DownloadStalledError({
            url,
            bytesDownloaded,
            bytesTotal: lastKnownTotal,
            idleTimeoutMs,
          })
        : rawErr instanceof Error
          ? rawErr
          : new Error(String(rawErr));

      if (attempt >= maxAttempts || !isRetryableDownloadError(err)) {
        throw new DownloadFailedError({
          url,
          label: options.label,
          attempts: attempt,
          bytesDownloaded,
          bytesTotal: lastKnownTotal,
          lastError: err,
        });
      }

      const delayMs =
        backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 1_000;
      options.onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        error: err,
        bytesDownloaded,
        bytesTotal: lastKnownTotal,
      });
      await sleep(delayMs);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Unreachable: the loop either returns or throws on the last attempt.
  throw new Error(`Download retry loop exited unexpectedly for ${url}`);
}

/**
 * Stream `url` to `destPath` with the same IDLE-deadline stall guard and
 * bounded retries as {@link downloadBufferWithStallGuard}, hashing as it
 * writes so a multi-hundred-MB artifact is never held in memory.
 *
 * Writes to `<destPath>.download` and does NOT rename — the caller verifies
 * the returned sha256 against its pin first, so a corrupt/tampered body can
 * never land at the real path. The temp file is removed on give-up.
 *
 * Each attempt restarts from byte 0 (no range-resume): these artifacts are
 * sha-pinned whole-file, and a resumed body that silently changed upstream
 * would fail the hash anyway.
 */
export async function downloadToFileWithStallGuard(
  url: string,
  destPath: string,
  options: StallGuardedDownloadOptions = {},
): Promise<{ tmpPath: string; bytesDownloaded: number; sha256: string }> {
  const tmpPath = `${destPath}.download`;
  await mkdir(dirname(destPath), { recursive: true });

  try {
    return await runGuardedDownload(url, options, async (res, ctx) => {
      // Fresh file + fresh hash per attempt — a retry must not append to
      // the bytes a half-finished attempt already wrote.
      const hash = createHash("sha256");
      const out = createWriteStream(tmpPath, { flags: "w" });
      let bytes = 0;

      const write = (chunk: Buffer): Promise<void> =>
        out.write(chunk)
          ? Promise.resolve()
          : once(out, "drain").then(() => undefined);

      try {
        if (!res.body) {
          // Bodyless Response (some test mocks / 204s).
          const buf = Buffer.from(await res.arrayBuffer());
          hash.update(buf);
          bytes = buf.length;
          ctx.bump(buf.length);
          await write(buf);
        } else {
          const reader = res.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            ctx.arm(); // bytes arrived — the connection is alive
            const chunk = Buffer.from(value);
            hash.update(chunk);
            bytes += chunk.length;
            ctx.bump(chunk.length);
            await write(chunk);
          }
        }
        await new Promise<void>((resolve, reject) => {
          out.once("error", reject);
          out.end(() => resolve());
        });
      } catch (e) {
        out.destroy();
        throw e;
      }

      return {
        tmpPath,
        bytesDownloaded: bytes,
        sha256: hash.digest("hex").toLowerCase(),
      };
    });
  } catch (e) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * Download `url` fully into memory with an IDLE-deadline stall guard and
 * bounded retries. See the module note above for the design rationale.
 *
 * Throws `DownloadFailedError` (actionable: host + url + label + bytes +
 * attempts) once it gives up; never hangs.
 *
 * Prefer {@link downloadToFileWithStallGuard} for large artifacts — this one
 * holds the whole body in memory.
 */
export async function downloadBufferWithStallGuard(
  url: string,
  options: StallGuardedDownloadOptions = {},
): Promise<Buffer> {
  const idleTimeoutMs =
    options.idleTimeoutMs ??
    envInt("LIBI_DOWNLOAD_IDLE_TIMEOUT_MS") ??
    DOWNLOAD_IDLE_TIMEOUT_MS;
  const maxAttempts =
    options.maxAttempts ??
    envInt("LIBI_DOWNLOAD_MAX_ATTEMPTS") ??
    DOWNLOAD_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? DOWNLOAD_RETRY_BACKOFF_MS;
  const doFetch = options.doFetch ?? fetchWithHttpsOnlyRedirects;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // Shared across attempts so the final error can report the best-known
  // bytesTotal even when the last attempt died before headers.
  let lastKnownTotal: number | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let bytesDownloaded = 0;
    const controller = new AbortController();
    let stalled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, idleTimeoutMs);
    };

    try {
      arm();
      const res = await doFetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new DownloadHttpError(res.status, res.statusText, res.url || url);
      }
      const contentLength = res.headers.get("content-length");
      const bytesTotal = contentLength ? parseInt(contentLength, 10) : null;
      if (bytesTotal != null) lastKnownTotal = bytesTotal;

      if (!res.body) {
        // Bodyless Response (some test mocks). Still signal-guarded.
        const buf = Buffer.from(await res.arrayBuffer());
        bytesDownloaded = buf.length;
        options.onProgress?.({ bytesDownloaded, bytesTotal });
        return buf;
      }

      const reader = res.body.getReader();
      const chunks: Buffer[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        arm(); // a chunk arrived — the connection is alive; reset the deadline
        chunks.push(Buffer.from(value));
        bytesDownloaded += value.length;
        options.onProgress?.({ bytesDownloaded, bytesTotal });
      }
      return Buffer.concat(chunks);
    } catch (rawErr) {
      const err: Error = stalled
        ? new DownloadStalledError({
            url,
            bytesDownloaded,
            bytesTotal: lastKnownTotal,
            idleTimeoutMs,
          })
        : rawErr instanceof Error
          ? rawErr
          : new Error(String(rawErr));

      if (attempt >= maxAttempts || !isRetryableDownloadError(err)) {
        throw new DownloadFailedError({
          url,
          label: options.label,
          attempts: attempt,
          bytesDownloaded,
          bytesTotal: lastKnownTotal,
          lastError: err,
        });
      }

      const delayMs =
        backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 1_000;
      options.onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        error: err,
        bytesDownloaded,
        bytesTotal: lastKnownTotal,
      });
      await sleep(delayMs);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Unreachable: the loop either returns or throws on the last attempt.
  throw new Error(`Download retry loop exited unexpectedly for ${url}`);
}
