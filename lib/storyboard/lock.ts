import fs from "fs/promises";
import type { FileHandle } from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { getLibiHome } from "@/lib/libi-home";
import { assertSafePieceId } from "@/lib/security/pieceId";
import { serverLogger as logger } from "@/lib/logger";
import { isWindows } from "@/lib/platform";

/**
 * Per-piece serialization for storyboard read-modify-write operations.
 *
 * Why a FILE lock and not only an in-process one: storyboard storage has
 * writers in more than one process. The Next server writes it from the
 * `/api/pieces/[pieceId]/storyboard/**` routes and snapshot restore, and the
 * MCP child (`serve-mcp-http`, or a stdio `serve-mcp`) runs
 * `mcp/tools/storyboard-tools.ts` IN-PROCESS — those tools call
 * `lib/storyboard/repo.ts` directly rather than going through the HTTP routes.
 * An in-process lock in either process alone would leave the other free to
 * load a stale board and save it over a fresh change.
 *
 * So the lock is two layers:
 *  1. an in-process promise chain per piece — waiters in the same process queue
 *     FIFO without polling the filesystem;
 *  2. a cross-process lock file, `<LIBI_HOME>/locks/storyboard/<pieceId>.lock`.
 *     It lives outside the piece's storage dir so the storyboard watcher never
 *     sees it and piece duplication never copies it.
 *
 * Publishing the lock file. Preferred: hard-link a fully written temp file onto
 * the lock path, so no other process can ever read a half-written owner record.
 * Hard links are NOT universal — exFAT / FAT32 / some SMB shares (the data folder
 * can be moved there, app/api/settings/data-folder) fail `link` with ENOTSUP /
 * EPERM / ENOSYS / EXDEV. So once per lock directory we PROBE link support with a
 * throwaway pair of files, and where it fails fall back to `open(lockPath, "wx")`
 * (exclusive create, atomic everywhere) and then write the owner record. That
 * leaves a moment where the lock file exists but is empty, so an empty or
 * unparseable lock file younger than UNREADABLE_GRACE_MS counts as HELD.
 *
 * Why a probe rather than reacting to the real link's error: EPERM means "no
 * hard links" on some filesystems but is also a TRANSIENT error on Windows
 * (antivirus / indexer holding the file), as are EBUSY and EACCES. Deciding link
 * support once, up front, lets the real acquisition loop treat EBUSY — and on
 * Windows also EPERM / EACCES — as "held, retry" until the deadline. On macOS /
 * Linux, EPERM / EACCES are real permission errors (a read-only data folder)
 * and are thrown at once instead of surfacing 60 s later as "busy". A probe that fails for a transient
 * reason only costs us the open("wx") path, which is correct too, just without
 * the no-half-written-record property. ENOTSUP / ENOSYS / EXDEV from a real link
 * later (never transient) flip that directory to open("wx") on the spot.
 *
 * Staleness. The owner record is `{ pid, host, acquiredAt, nonce }`, stamped at
 * the moment of each publish attempt (never when waiting began — a waiter that
 * waited long would otherwise publish an already-"old" record and be stolen from
 * the moment it acquired). A lock is stale when:
 *  - its pid is dead (ESRCH) on this host — regardless of age;
 *  - its pid is THIS process and its nonce is not a hold this process still has
 *    (a leaked lock whose release failed) — regardless of age;
 *  - its pid is alive, it is older than STALE_MS, AND `ps` shows that pid
 *    started after `acquiredAt` (the pid was reused by an unrelated process
 *    after the holder crashed). The `ps` answer is cached per (pid, acquiredAt)
 *    so a blocked waiter spawns it once, not every poll;
 *  - it is older than MAX_HOLD_MS (2 min), whoever holds it. This is the
 *    backstop for what liveness can't settle: a pid reused on Windows (no cheap
 *    start-time probe there) and a lock LEAKED by a live process whose release
 *    could not remove the file. Lock files survive restarts, so without it
 *    either would leave the piece unwritable until that process exits — for a
 *    reused system pid, until reboot. 2 min because a real hold is one
 *    load→save (milliseconds; seconds on a slow network share), so a record
 *    that old is >1000× any real hold, and every waiter that queued behind it
 *    has already given up at its own 60 s deadline. The residual risk is a
 *    holder genuinely hung in I/O for 2 min having its write interleaved;
 *  - its owner can't be probed (another host on a shared folder, or no pid) and
 *    it is older than STALE_MS;
 *  - it is empty / unparseable and older than UNREADABLE_GRACE_MS.
 * A live pid is otherwise HELD until MAX_HOLD_MS.
 *
 * Stealing renames the stale file to a unique name, then checks the renamed
 * content is the record it judged stale; if it isn't (another waiter stole it
 * and a new holder took the lock in between), it puts the file back. Residual
 * race: if yet another process acquires in the microseconds between our rename
 * and the put-back, the put-back fails and two holders briefly coexist — logged
 * as `lock_steal_race`. It needs three contenders AND a genuinely stale lock.
 *
 * Release reads the file and removes it only if it still carries our record.
 * The read→rm gap can't lose someone else's lock on one host: a live holder's
 * lock is never stale by the rules above, so nobody can have stolen and
 * re-taken it. Across hosts sharing a folder (age-based) it could, after
 * STALE_MS; holds are milliseconds, so that needs a >30 s hold.
 *
 * Hold it ONLY across load → mutate → save (milliseconds). Never across renders,
 * generation, or network work. It is not re-entrant: never call a locking repo
 * function from inside a locked callback.
 *
 * Direct file edits by an agent (card.json is file-as-source-of-truth) cannot
 * take this lock; they only race the few-ms load→save window of a repo write.
 */

type Tuning = {
  /** Owner record age past which an un-probeable (or pid-reused) holder is stale. */
  staleMs: number;
  /** One deadline for the whole acquisition: in-process queue + file lock. */
  acquireTimeoutMs: number;
  /** An empty/unparseable lock file younger than this is a holder mid-write. */
  unreadableGraceMs: number;
  /** Any record older than this is stale, whoever holds it (see header). */
  maxHoldMs: number;
  pollMinMs: number;
  pollMaxMs: number;
  /** Retry EPERM / EACCES as transient (default: on Windows only). */
  accessErrorsTransient: boolean;
  /** Clock for stamping and aging records (tests jump it). */
  now: () => number;
  /** Delays of the background retries of a release whose rm failed. */
  backgroundReleaseDelaysMs: number[];
};

const DEFAULT_TUNING: Tuning = {
  staleMs: 30_000,
  acquireTimeoutMs: 60_000,
  unreadableGraceMs: 5_000,
  maxHoldMs: 120_000,
  pollMinMs: 5,
  pollMaxMs: 25,
  accessErrorsTransient: isWindows(),
  now: () => Date.now(),
  backgroundReleaseDelaysMs: [1_000, 5_000, 30_000],
};
let tuning: Tuning = { ...DEFAULT_TUNING };

/** Test/QA hook: shrink the timings so staleness and timeouts are exercised in
 *  milliseconds. Also forgets the per-directory link-support probe results.
 *  Pass nothing to restore the defaults. */
export function __setStoryboardLockTuningForTests(overrides?: Partial<Tuning>): void {
  tuning = { ...DEFAULT_TUNING, ...(overrides ?? {}) };
  publishModeByDir.clear();
  startTimeCache.clear();
}

/** Test hook: how many `ps` start-time probes this module has spawned. */
export function __storyboardLockStatsForTests(): { psSpawns: number } {
  return { psSpawns };
}

export const STORYBOARD_BUSY_MESSAGE =
  "Storyboard is busy — another edit to this piece is still in progress. Retry in a moment.";

/** For a busy error raised AFTER the caller already changed something else
 *  (commit/discard draft: the composition step ran, then the storyboard step
 *  timed out) — so "just retry" would be wrong. */
export const STORYBOARD_BUSY_PARTIAL_MESSAGE =
  "Storyboard is busy — another edit to this piece is still in progress, so this change may have been only partly applied. Check the piece's current state before retrying.";

export class StoryboardBusyError extends Error {
  /** True when other work in the same operation already landed. */
  readonly partial: boolean;
  constructor(opts: { partial?: boolean } = {}) {
    super(opts.partial ? STORYBOARD_BUSY_PARTIAL_MESSAGE : STORYBOARD_BUSY_MESSAGE);
    this.name = "StoryboardBusyError";
    this.partial = opts.partial === true;
  }
}

/** Rethrow `err`, marking a storyboard busy error as partial (see above). */
export function rethrowStoryboardBusyAsPartial(err: unknown): never {
  if (isStoryboardBusyError(err)) throw new StoryboardBusyError({ partial: true });
  throw err;
}

/** By name, not instanceof: tests (and bundling) can load this module twice. */
export function isStoryboardBusyError(err: unknown): err is StoryboardBusyError {
  return err instanceof Error && err.name === "StoryboardBusyError";
}

const chains = new Map<string, Promise<void>>();

/** Nonces of the file locks this PROCESS currently holds. On globalThis so every
 *  module instance in the process (tests load several) agrees. */
const LIVE_KEY = Symbol.for("libi.storyboardLock.liveNonces");
const liveNonces: Set<string> = ((globalThis as Record<symbol, unknown>)[LIVE_KEY] ??=
  new Set<string>()) as Set<string>;

type PublishMode = "link" | "open";
const publishModeByDir = new Map<string, Promise<PublishMode>>();

/** Link errors that mean "this filesystem has no hard links" — never transient. */
const LINK_UNSUPPORTED = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);
/** "Held, retry until the deadline": EBUSY everywhere; EPERM / EACCES only where
 *  they are usually a scanner/indexer holding the file for a moment (Windows). */
function isTransient(c: string | undefined): boolean {
  if (c === "EBUSY") return true;
  return (c === "EPERM" || c === "EACCES") && tuning.accessErrorsTransient;
}

export function storyboardLockPath(pieceId: string): string {
  assertSafePieceId(pieceId);
  return path.join(getLibiHome(), "locks", "storyboard", `${pieceId}.lock`);
}

type Owner = { pid: number; host: string; acquiredAt: number; nonce: string };

const code = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pollDelay = () => tuning.pollMinMs + Math.random() * (tuning.pollMaxMs - tuning.pollMinMs);

async function rmBestEffort(p: string, op: string, pieceId: string): Promise<void> {
  try {
    await fs.rm(p, { force: true });
  } catch (err) {
    logger.warn({ tag: "storyboard", op, pieceId, path: p, code: code(err) }, "could not remove storyboard lock temp file");
  }
}

function publishMode(dir: string, pieceId: string): Promise<PublishMode> {
  let mode = publishModeByDir.get(dir);
  if (!mode) {
    mode = (async (): Promise<PublishMode> => {
      const probe = path.join(dir, `.probe-${randomUUID()}`);
      try {
        await fs.writeFile(probe, "");
        await fs.link(probe, `${probe}.lnk`);
        return "link";
      } catch (err) {
        logger.info(
          { tag: "storyboard", op: "lock_link_unsupported", pieceId, dir, code: code(err) },
          "hard links unavailable for storyboard locks here; using exclusive create",
        );
        return "open";
      } finally {
        await rmBestEffort(`${probe}.lnk`, "lock_probe_cleanup_failed", pieceId);
        await rmBestEffort(probe, "lock_probe_cleanup_failed", pieceId);
      }
    })();
    publishModeByDir.set(dir, mode);
  }
  return mode;
}

let psSpawns = 0;
const startTimeCache = new Map<string, Promise<number | null>>();

/** Start time (epoch ms, ±1 s) of a live pid, or null when it can't be read
 *  (Windows, no `ps`, or the process vanished). Only consulted for a live pid
 *  whose record is already older than STALE_MS, and cached per (pid,
 *  acquiredAt) — the same record is the same question, however long we poll. */
function pidStartedAt(pid: number, acquiredAt: number): Promise<number | null> {
  const key = `${pid}:${acquiredAt}`;
  let hit = startTimeCache.get(key);
  if (!hit) {
    if (startTimeCache.size >= 64) startTimeCache.clear();
    hit = probePidStart(pid);
    startTimeCache.set(key, hit);
  }
  return hit;
}

function probePidStart(pid: number): Promise<number | null> {
  if (isWindows()) return Promise.resolve(null);
  psSpawns++;
  return new Promise((resolve) => {
    execFile("ps", ["-o", "etime=", "-p", String(pid)], { timeout: 2000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      // [[dd-]hh:]mm:ss
      const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(stdout);
      if (!m) return resolve(null);
      const [, d, h, mi, s] = m;
      const secs = Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(s);
      resolve(tuning.now() - secs * 1000);
    });
  });
}

/** The lock file's raw content when its holder is stale (see the header), else
 *  null (held, or already gone — either way: retry). */
async function staleContent(lockPath: string): Promise<string | null> {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = await fs.readFile(lockPath, "utf8");
    mtimeMs = (await fs.stat(lockPath)).mtimeMs;
  } catch {
    return null; // released (or unreadable for a moment) — just retry
  }
  const now = tuning.now();
  let owner: Partial<Owner> | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") owner = parsed as Partial<Owner>;
  } catch {
    owner = null;
  }
  if (!owner) {
    // Empty/garbled: a holder between open("wx") and its write, or a crash there.
    return now - mtimeMs > tuning.unreadableGraceMs ? raw : null;
  }
  const acquiredAt = typeof owner.acquiredAt === "number" ? owner.acquiredAt : mtimeMs;
  if (now - acquiredAt > tuning.maxHoldMs) return raw; // backstop — see header
  const aged = now - acquiredAt > tuning.staleMs;
  const probeable = typeof owner.pid === "number" && (owner.host === undefined || owner.host === os.hostname());
  if (!probeable) return aged ? raw : null;
  const pid = owner.pid as number;
  if (pid === process.pid) {
    // Ours: held iff it is a hold this process still has.
    return typeof owner.nonce === "string" && liveNonces.has(owner.nonce) ? null : raw;
  }
  try {
    process.kill(pid, 0); // signal 0: liveness probe only
  } catch (err) {
    if (code(err) === "ESRCH") return raw; // dead holder: stale at any age
    // EPERM: alive, owned by someone else. Fall through as alive.
  }
  // Alive. Windows can't tell a reused pid (probePidStart → null), and a lock
  // leaked by a live process looks the same: both wait for MAX_HOLD_MS above.
  if (!aged) return null;
  const startedAt = await pidStartedAt(pid, acquiredAt);
  // ps has 1 s resolution; allow 2 s before calling it a different process.
  return startedAt !== null && startedAt > acquiredAt + 2000 ? raw : null;
}

/** Try to steal a lock judged stale with content `stale`. Resolves true when
 *  the lock path is now free to try at once, false when the caller should back
 *  off (the rename failed — e.g. an undeletable file — or we had to put back a
 *  lock someone else holds). */
async function steal(lockPath: string, stale: string, mode: PublishMode, pieceId: string): Promise<boolean> {
  const aside = `${lockPath}.stale-${randomUUID()}`;
  try {
    await fs.rename(lockPath, aside);
  } catch (err) {
    return code(err) === "ENOENT"; // already gone → retry now; otherwise back off
  }
  let got: string | null = null;
  try {
    got = await fs.readFile(aside, "utf8");
  } catch {
    got = null;
  }
  if (got === stale) {
    logger.warn({ tag: "storyboard", op: "lock_stale_steal", pieceId }, "stealing stale storyboard lock");
    await rmBestEffort(aside, "lock_stale_cleanup_failed", pieceId);
    return true;
  }
  // We moved a lock that is not the one we judged: a faster waiter stole the
  // stale one and a new holder took the lock. Put it back.
  try {
    if (mode === "link") {
      await fs.link(aside, lockPath);
    } else {
      const fh = await fs.open(lockPath, "wx");
      try {
        await fh.writeFile(got ?? "");
      } finally {
        await fh.close();
      }
    }
  } catch (err) {
    logger.warn(
      { tag: "storyboard", op: "lock_steal_race", pieceId, code: code(err) },
      "could not restore a storyboard lock moved during a stale steal",
    );
  }
  await rmBestEffort(aside, "lock_stale_cleanup_failed", pieceId);
  return false;
}

/** One attempt to publish `record` at `lockPath`. true = acquired, false = held
 *  (retry). Throws only on errors that retrying can't fix. */
async function tryPublish(lockPath: string, tmp: string, record: string, dir: string, pieceId: string): Promise<boolean> {
  const mode = await publishMode(dir, pieceId);
  if (mode === "link") {
    try {
      await fs.writeFile(tmp, record); // fresh record per attempt (acquiredAt = now)
    } catch (err) {
      if (isTransient(code(err))) return false;
      throw err;
    }
    try {
      await fs.link(tmp, lockPath); // atomic; EEXIST when held
      return true;
    } catch (err) {
      const c = code(err) ?? "";
      if (c === "EEXIST" || isTransient(c)) return false;
      if (LINK_UNSUPPORTED.has(c)) {
        logger.info({ tag: "storyboard", op: "lock_link_unsupported", pieceId, dir, code: c }, "hard link failed; switching to exclusive create");
        publishModeByDir.set(dir, Promise.resolve("open"));
        return tryPublish(lockPath, tmp, record, dir, pieceId);
      }
      throw err;
    }
  }
  let fh: FileHandle;
  try {
    fh = await fs.open(lockPath, "wx");
  } catch (err) {
    const c = code(err) ?? "";
    if (c === "EEXIST" || isTransient(c)) return false;
    throw err;
  }
  try {
    await fh.writeFile(record);
    await fh.close();
    return true;
  } catch (err) {
    await fh.close().catch(() => {});
    await rmBestEffort(lockPath, "lock_release_failed", pieceId);
    throw err;
  }
}

/** Retry removing a lock file whose release failed. Each attempt runs as a
 *  turn of the piece's IN-PROCESS queue, so no acquisition in this process can
 *  reclaim the leaked lock and publish a fresh one between our read and our
 *  rm (that would make us delete a live lock). Other processes can't slip in
 *  either: they see our live pid and treat the file as held until MAX_HOLD_MS
 *  (2 min), well past the last retry (~36 s). */
function retryReleaseInBackground(lockPath: string, mark: string, pieceId: string, attempt = 0): void {
  const delays = tuning.backgroundReleaseDelaysMs;
  if (attempt >= delays.length) return;
  const t = setTimeout(() => {
    void enqueue(pieceId, async () => {
      try {
        // Still ours? (A queued acquisition may have reclaimed it meanwhile.)
        if ((await fs.readFile(lockPath, "utf8")) !== mark) return;
        await fs.rm(lockPath, { force: true });
        logger.info({ tag: "storyboard", op: "lock_release_recovered", pieceId, attempt }, "removed leaked storyboard lock");
      } catch (err) {
        if (code(err) === "ENOENT") return;
        retryReleaseInBackground(lockPath, mark, pieceId, attempt + 1);
      }
    });
  }, delays[attempt]);
  t.unref?.();
}

/** Run `fn` as one turn of the piece's in-process FIFO queue (no deadline, no
 *  file lock). */
function enqueue(pieceId: string, fn: () => Promise<void>): Promise<void> {
  const prev = chains.get(pieceId) ?? Promise.resolve();
  let releaseChain!: () => void;
  const mine = new Promise<void>((r) => { releaseChain = r; });
  const tail = prev.then(() => mine);
  chains.set(pieceId, tail);
  return prev.then(fn).finally(() => {
    releaseChain();
    if (chains.get(pieceId) === tail) chains.delete(pieceId);
  });
}

async function acquireFileLock(pieceId: string, deadline: number): Promise<() => Promise<void>> {
  const lockPath = storyboardLockPath(pieceId);
  const dir = path.dirname(lockPath);
  await fs.mkdir(dir, { recursive: true });
  const nonce = randomUUID();
  const tmp = path.join(dir, `.${pieceId}.${nonce}.tmp`);
  const host = os.hostname();
  let mark = "";
  try {
    for (;;) {
      // Stamp acquiredAt at the attempt, not when waiting began.
      const record = JSON.stringify({ pid: process.pid, host, acquiredAt: tuning.now(), nonce } satisfies Owner);
      liveNonces.add(nonce); // before publishing, so our own process never judges it stale
      if (await tryPublish(lockPath, tmp, record, dir, pieceId)) {
        mark = record;
        break;
      }
      liveNonces.delete(nonce);
      const mode = await publishMode(dir, pieceId);
      const stale = await staleContent(lockPath);
      // Only a steal that actually freed the path retries at once; anything else
      // (held, or a steal that couldn't move the file) backs off and honours
      // the deadline — an undeletable stale file must not become a hot spin.
      if (stale !== null && (await steal(lockPath, stale, mode, pieceId))) continue;
      if (tuning.now() >= deadline) {
        logger.warn({ tag: "storyboard", op: "lock_timeout", pieceId, phase: "file" }, "storyboard lock not released in time");
        throw new StoryboardBusyError();
      }
      await sleep(pollDelay());
    }
  } catch (err) {
    liveNonces.delete(nonce);
    throw err;
  } finally {
    // Best-effort: a scanner holding the temp file must not fail a write whose
    // lock we already hold (and would then leak).
    await rmBestEffort(tmp, "lock_tmp_cleanup_failed", pieceId);
  }
  return async () => {
    try {
      // Only remove the lock if it is still ours.
      let current: string | null;
      try {
        current = await fs.readFile(lockPath, "utf8");
      } catch {
        current = null; // already gone
      }
      if (current !== mark) return;
      let lastErr: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await fs.rm(lockPath, { force: true });
          return;
        } catch (err) {
          lastErr = err;
          await sleep(20 * 2 ** attempt);
        }
      }
      // Left behind with our live pid. Our own process judges it stale at once
      // (the nonce is dropped below); other processes would wait for
      // MAX_HOLD_MS, so keep trying in the background — a scanner usually lets
      // go within seconds.
      logger.warn(
        { tag: "storyboard", op: "lock_release_failed", pieceId, code: code(lastErr) },
        "could not remove storyboard lock file; retrying in the background",
      );
      retryReleaseInBackground(lockPath, mark, pieceId);
    } finally {
      liveNonces.delete(nonce);
    }
  };
}

/** Run `fn` holding the piece's storyboard lock (in-process + cross-process).
 *  Throws StoryboardBusyError when the lock can't be had within the timeout. */
export async function withStoryboardLock<T>(pieceId: string, fn: () => Promise<T> | T): Promise<T> {
  const deadline = tuning.now() + tuning.acquireTimeoutMs;
  const prev = chains.get(pieceId) ?? Promise.resolve();
  let releaseChain!: () => void;
  const mine = new Promise<void>((r) => { releaseChain = r; });
  // Successors wait for `prev` AND us, so giving up early below never lets
  // them overtake a holder still ahead of us.
  const tail = prev.then(() => mine);
  chains.set(pieceId, tail);
  try {
    let timer: NodeJS.Timeout | undefined;
    const queued = await Promise.race([
      prev.then(() => true),
      new Promise<false>((r) => { timer = setTimeout(() => r(false), Math.max(0, deadline - tuning.now())); }),
    ]);
    clearTimeout(timer);
    if (!queued) {
      logger.warn({ tag: "storyboard", op: "lock_timeout", pieceId, phase: "queue" }, "storyboard lock queue did not drain in time");
      throw new StoryboardBusyError();
    }
    const releaseFile = await acquireFileLock(pieceId, deadline);
    try {
      return await fn();
    } finally {
      await releaseFile();
    }
  } finally {
    releaseChain();
    if (chains.get(pieceId) === tail) chains.delete(pieceId);
  }
}
