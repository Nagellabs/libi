/**
 * The ONE path from a public http(s) URL to a stored piece file.
 *
 * `remote_fetch` (the agent-facing import tool) and the onboarding asset
 * build both go through here, so the SSRF guard, the redirect re-vetting, the
 * byte cap, the content-type fallback and proxy generation cannot drift apart
 * the way two hand-rolled `fetch` + `storeFile` bodies inevitably would.
 *
 * The guard is a PARAMETER, never a decision made in here: each caller passes
 * the guard its own trust model demands (`assertPublicHttpUrl` for anything a
 * user or agent supplied). This module must not pick one.
 *
 * Deliberately free of `lib/jobs/*` imports — the MCP child, which may not
 * touch the job layer at all, is a legitimate future caller.
 */

import path from "node:path";
import { fetchFollowingVettedRedirects, type UrlGuard } from "@/lib/net/follow-redirects";
import { sha256OfBuffer } from "@/lib/security/download-verify";
import { storeFile, mimeFromExtension } from "@/mcp/tools/file-tools";

/** Maximum download size per file: 500 MB. */
export const MAX_BYTES = 500 * 1024 * 1024;

/** How long one download (headers + body) gets before it is aborted. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Read a fetch Response body into a Buffer, enforcing a hard byte cap AS the
 * stream arrives. A server that lies about (or omits) Content-Length can't make
 * us buffer an unbounded body — the moment the running counter exceeds the cap
 * we abort the in-flight download instead of reading it to completion.
 */
export async function readBodyWithCap(res: Response, maxBytes: number): Promise<Buffer> {
  const body = res.body;
  if (!body) {
    // No stream (empty body) — arrayBuffer is already bounded by the empty body.
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new Error(`file too large: ${buf.byteLength} bytes (max ${maxBytes})`);
    }
    return buf;
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let capped = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        capped = true;
        throw new Error(`file too large: exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    // On a cap breach, cancel the underlying stream so the socket is freed and
    // the remote download is aborted rather than draining in the background.
    if (capped) void body.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, total);
}

/**
 * The content type a response DECLARED, or null when it declared nothing
 * usable — which includes `application/octet-stream`.
 *
 * `application/octet-stream` is the "I have no idea" answer, and it is what a
 * bucket serves for every object whose type was never set on upload. Taken at
 * face value it DEFEATS the extension fallback below and is strictly worse
 * than an absent header: `categorizeFileType` files the download as
 * `type: "other"`, which skips `storeFile`'s ffprobe pass — so no duration, no
 * dimensions, no proxy, and a tracked overlay riding that video has no source
 * dims to map its track boxes into the composition with. That is a real bug
 * that reached the onboarding film; it is fixed HERE, at the one download
 * path, rather than at each caller, because every caller
 * (`remote_fetch` included) hits it identically.
 *
 * Parameters are ignored (`application/octet-stream; charset=binary` is the
 * same non-answer), but an informative header is returned verbatim so a
 * charset or codecs parameter survives to `storeFile`.
 */
function declaredContentType(header: string | null): string | null {
  if (!header) return null;
  const essence = header.split(";")[0].trim().toLowerCase();
  if (!essence || essence === "application/octet-stream") return null;
  return header;
}

export interface FetchRemoteBufferOptions {
  url: string;
  guard: UrlGuard;
  /** Filename to report/store under. Defaults to the URL's basename. */
  filename?: string;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface FetchRemoteBufferResult {
  buffer: Buffer;
  filename: string;
  contentType: string | null;
}

/**
 * Download one guarded URL into memory, capped. Split out from
 * {@link fetchAndStoreRemoteFile} because `remote_fetch`'s `autoUpload: false`
 * mode needs exactly these bytes without a DB row — having it write its own
 * `fetch` for that branch is precisely the drift this module exists to stop.
 */
export async function fetchRemoteBuffer(
  opts: FetchRemoteBufferOptions,
): Promise<FetchRemoteBufferResult> {
  const { url, guard } = opts;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;

  // SSRF guard, re-applied to EVERY hop of the redirect chain (not just
  // the start and the final `res.url`): resolves DNS and throws for
  // private/loopback/metadata addresses, including a hostname that
  // merely resolves to one, before that hop is ever dereferenced.
  const res = await fetchFollowingVettedRedirects(url, guard, {
    signal: opts.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`http ${res.status}`);
  }

  // Cheap pre-check: reject obviously-too-large downloads from the
  // declared Content-Length before reading a single byte of the body.
  const declaredLen = Number(res.headers.get("content-length"));
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    throw new Error(`file too large: ${declaredLen} bytes (max ${maxBytes})`);
  }

  // Stream the body with a running byte cap — the Content-Length check is
  // advisory (a server can lie or omit it), so the cap is enforced for
  // real as bytes arrive.
  const buffer = await readBodyWithCap(res, maxBytes);

  // `path.basename` returns "" for a url whose path is just "/", so the
  // literal fallback is reachable — `??` would not catch it. Callers that
  // need a collision-free name for a basename-less url (`remote_fetch`'s
  // no-dedupe local-file branch) pass their own `filename`.
  const filename =
    opts.filename || path.basename(new URL(url).pathname) || "download.bin";
  // A declared type wins; an absent OR opaque (`application/octet-stream`) one
  // falls back to the extension. See `declaredContentType`.
  const contentType =
    declaredContentType(res.headers.get("content-type")) ?? mimeFromExtension(filename);

  return { buffer, filename, contentType };
}

export interface FetchAndStoreOptions {
  url: string;
  guard: UrlGuard;
  pieceId: string | null;
  /** Filename to store under. Defaults to the URL's basename. */
  filename?: string;
  /** When set, the downloaded bytes must hash to this or nothing is stored. */
  expectSha256?: string;
  /** Overrides the content type the response declared. For a download whose
   *  bytes are PINNED (`expectSha256`), the caller knows the media type as a
   *  fact of its own definition, and a bucket serving
   *  `application/octet-stream` would otherwise land the file as type "other"
   *  — unprobed, so no duration, no dimensions, no proxy, and a tracked
   *  overlay left without the source dims it maps its boxes with. */
  contentType?: string;
  /** Don't enqueue `proxy_gen` for this download. For assets that are WATCHED
   *  IMMEDIATELY, where a mid-playback source swap costs more than scrub
   *  density: when the proxy lands, `proxy-gen` emits `refresh_query`,
   *  `buildComposition` re-runs, `pickVideoUrl` starts returning the proxy and
   *  the overlays' `videoUrl` change underneath a playing preview. A proxy
   *  buys nothing for a source that is already ≤1080p except denser GOPs for
   *  scrubbing, so for a clip the user is watching rather than scrubbing the
   *  trade is one-sided. */
  skipProxyGeneration?: boolean;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface FetchAndStoreResult {
  fileId: string;
  bytes: number;
  /** The name the file was ACTUALLY stored under. `storeFile` dedupes within
   *  a scope, so a re-run can land as `logo-mark (1).png` — a caller that used
   *  the requested name to find the bytes on disk would be looking at the
   *  wrong file. */
  filename: string;
}

/** A pinned hash is 64 lowercase hex chars. Anything else is a mistake in the
 *  caller, and this is the one module whose job is refusing a bad download —
 *  so a malformed expectation throws rather than quietly skipping the check. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Download one public http(s) file and register it as a piece file.
 *  The single download path — `remote_fetch` and the onboarding build both
 *  call this, so the SSRF guard, the byte cap and proxy generation cannot
 *  drift apart. */
export async function fetchAndStoreRemoteFile(
  opts: FetchAndStoreOptions,
): Promise<FetchAndStoreResult> {
  const { buffer, filename, contentType } = await fetchRemoteBuffer(opts);

  // Hash BEFORE storing. A mismatch caught after `storeFile` would leave
  // bytes on disk and a row in the DB for the caller to unwind; caught here
  // there is nothing to clean up.
  //
  // `!== undefined`, not truthiness: `expectSha256: ""` would otherwise fail
  // OPEN and store an unverified download, which is the opposite of what
  // asking for a hash means.
  if (opts.expectSha256 !== undefined) {
    const want = opts.expectSha256.trim().toLowerCase();
    if (!SHA256_HEX.test(want)) {
      throw new Error(
        `invalid expectSha256 for ${filename}: expected 64 hex characters, ` +
          `got ${JSON.stringify(opts.expectSha256)} — refusing to store an unverified download.`,
      );
    }
    const actual = sha256OfBuffer(buffer);
    if (actual !== want) {
      throw new Error(
        `sha256 mismatch for ${filename}: expected ${want.slice(0, 16)}…, ` +
          `got ${actual.slice(0, 16)}… — refusing to store a tampered/corrupt download.`,
      );
    }
  }

  const record = await storeFile({
    pieceId: opts.pieceId,
    filename,
    buffer,
    contentType: opts.contentType ?? contentType,
    skipProxyGeneration: opts.skipProxyGeneration,
  });

  // `record.filename`, not the requested `filename` — see the field's note.
  return { fileId: record.id, bytes: buffer.byteLength, filename: record.filename };
}
