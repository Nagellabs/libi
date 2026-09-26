// mcp/registry/install-lock.ts
//
// A cross-process lock around the install of one dependency.
//
// `DependencyManager`'s single-flight (`depInstallFlights`) is process memory,
// so it cannot see a SECOND libi. Two do share one `<LIBI_HOME>/bin` in dev:
// every worktree's home links `bin/`, `uv/` and `models/` to the canonical
// `~/.libi` (lib/dev/worktree-bootstrap.ts SHARED_LINKS). Two of them repairing
// yt-dlp at once each ran `uv tool install --reinstall --force` into the same
// tool dir, and the second wiped the venv the first was about to run.
//
// The lock is a file created with O_EXCL next to what the install writes,
// holding the owner's pid and start time. A caller that finds it held WAITS,
// and the DependencyManager then re-checks "installed?" before doing anything:
// the other process's install has usually served it, so it is not repeated.
//
// A lock is stale — taken over — when its owner is gone:
//   - its pid is not running (a crash, a kill -9), or
//   - its heartbeat stopped: the owner touches the file every
//     HEARTBEAT_MS, so an mtime older than STALE_MS means the owner is frozen,
//     or the pid now belongs to an unrelated process (pid reuse).
// An install has its own timeout, so an owner that is alive and heartbeating
// is waited for — up to INSTALL_LOCK_MAX_WAIT_MS, above the longest install
// timeout (tracking's 30 min), after which the waiter gives up with a plain
// error rather than wait on a hung owner forever.
//
// Taking over a stale lock is: re-read it, remove it only if it is still the
// SAME lock that was judged stale (same content, same mtime), then retry
// O_EXCL. That narrows, but does not close, the race between two waiters that
// judge one lock stale at the same moment: if one waiter's remove lands after
// the other's fresh create, both install. For a downloaded binary that is
// harmless (`placeBinary` writes a temp file and renames it into place); for a
// custom installer — yt-dlp's `uv tool install --reinstall --force`, tracking's
// `uv sync` — two runs can collide, which is the thing this lock exists to
// prevent. It needs an owner that crashed or froze AND two other libis whose
// checks interleave within a syscall, so it is accepted rather than engineered
// away. Kept small on purpose — this is coordination for a dev setup, not a
// general-purpose mutex.

import fs from "node:fs";
import path from "node:path";
import { serverLogger as logger } from "@/lib/logger";
import { isWindows } from "@/lib/platform";

/** The owner touches the lock this often while it holds it. */
export const INSTALL_LOCK_HEARTBEAT_MS = 15_000;
/** A lock whose mtime is older than this has lost its owner. */
export const INSTALL_LOCK_STALE_MS = 2 * 60_000;
/** How often a waiter looks again. */
const POLL_MS = 250;
/** The longest a waiter waits on a live owner: above every install's own
 *  timeout (tracking 30 min, Chromium 10 min), so it only fires on a hung one. */
export const INSTALL_LOCK_MAX_WAIT_MS = 35 * 60_000;
/** Create errors Windows can raise for a moment (an antivirus scan, a name
 *  whose delete is still pending) — retried before giving up on the lock. */
const TRANSIENT_CREATE_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const TRANSIENT_CREATE_RETRIES = 5;
const TRANSIENT_CREATE_DELAY_MS = 100;

/** A waiter gave up on a live owner after INSTALL_LOCK_MAX_WAIT_MS. */
export class InstallLockTimeoutError extends Error {
  constructor(lockPath: string, waitedMs: number) {
    const what = path.basename(lockPath).replace(/\.install-lock$/, "");
    super(
      `Another libi on this computer has been installing ${what} for over ${Math.round(waitedMs / 60_000)} minutes. ` +
        "Quit the other libi (or wait for it to finish), then try again.",
    );
    this.name = "InstallLockTimeoutError";
  }
}

interface LockBody {
  pid: number;
  startedAt: string;
}

export interface InstallLockHandle {
  /** True when another process held the lock and this caller waited for it. */
  waited: boolean;
  release: () => void;
}

export interface InstallLockOptions {
  staleMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
  maxWaitMs?: number;
  /** Injected for tests. */
  isAlive?: (pid: number) => boolean;
}

/** Locks this process holds right now — so a lock file naming OUR pid that we
 *  do not hold is recognised as a leftover (a previous process whose pid we
 *  were given), not as ours. On `globalThis`: Next can load this module twice. */
function heldByThisProcess(): Set<string> {
  const g = globalThis as { __libiInstallLocksHeld?: Set<string> };
  g.__libiInstallLocksHeld ??= new Set();
  return g.__libiInstallLocksHeld;
}

/** Is a process with this pid running? EPERM counts: it exists, it just is not ours to signal. */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lock's raw text, or null when it cannot be read. Read through a file
 *  descriptor rather than readFileSync, which some suites mock. */
function readText(lockPath: string): string | null {
  try {
    const fd = fs.openSync(lockPath, "r");
    try {
      const buf = Buffer.alloc(512);
      return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function parseBody(text: string | null): LockBody | null {
  if (text === null) return null;
  try {
    const body = JSON.parse(text) as Partial<LockBody>;
    return typeof body.pid === "number" ? { pid: body.pid, startedAt: String(body.startedAt) } : null;
  } catch {
    return null;
  }
}

function readBody(lockPath: string): LockBody | null {
  return parseBody(readText(lockPath));
}

/** What a lock looked like when it was judged: its text and its mtime. */
interface LockSnapshot {
  text: string | null;
  mtimeMs: number;
}

function snapshot(lockPath: string): LockSnapshot | null {
  try {
    const mtimeMs = fs.statSync(lockPath).mtimeMs;
    return { text: readText(lockPath), mtimeMs };
  } catch {
    return null; // released meanwhile — the next O_EXCL attempt decides
  }
}

function removeLock(lockPath: string): void {
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    /* the next create attempt decides */
  }
}

/** Why the lock seen in `seen` has no live owner, or null when it has one. */
function staleReason(
  lockPath: string,
  seen: LockSnapshot,
  staleMs: number,
  isAlive: (pid: number) => boolean,
): string | null {
  if (Date.now() - seen.mtimeMs > staleMs) return "heartbeat_stopped";
  const body = parseBody(seen.text);
  // Unreadable and fresh: an owner between creating the file and writing it.
  if (!body) return null;
  if (body.pid === process.pid) {
    return heldByThisProcess().has(lockPath) ? null : "leftover_own_pid";
  }
  return isAlive(body.pid) ? null : "owner_dead";
}

/**
 * Take the lock at `lockPath`, waiting while another live process holds it.
 * Throws only when a live owner has held it past `maxWaitMs`
 * (InstallLockTimeoutError). An unexpected filesystem error (the directory is
 * not writable, say) is logged and the caller proceeds unlocked — the lock is
 * coordination, and an install must not fail because of it.
 */
export async function acquireInstallLock(
  lockPath: string,
  opts: InstallLockOptions = {},
): Promise<InstallLockHandle> {
  const staleMs = opts.staleMs ?? INSTALL_LOCK_STALE_MS;
  const heartbeatMs = opts.heartbeatMs ?? INSTALL_LOCK_HEARTBEAT_MS;
  const pollMs = opts.pollMs ?? POLL_MS;
  const isAlive = opts.isAlive ?? pidIsAlive;
  const maxWaitMs = opts.maxWaitMs ?? INSTALL_LOCK_MAX_WAIT_MS;
  const firstTry = Date.now();
  let transientRetries = 0;
  let waited = false;
  let loggedWait = false;
  let startedAt = "";
  let takeovers = 0;

  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      startedAt = new Date().toISOString();
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt }));
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (
        code &&
        TRANSIENT_CREATE_CODES.has(code) &&
        isWindows() &&
        transientRetries++ < TRANSIENT_CREATE_RETRIES
      ) {
        await new Promise((resolve) => setTimeout(resolve, TRANSIENT_CREATE_DELAY_MS));
        continue;
      }
      if (code !== "EEXIST") {
        logger.warn(
          { tag: "dep-install", op: "install_lock_unavailable", lockPath, err: (err as Error).message },
          "could not create the install lock; installing without it",
        );
        return { waited, release: () => {} };
      }
    }
    const seen = snapshot(lockPath);
    if (!seen) continue;
    const reason = staleReason(lockPath, seen, staleMs, isAlive);
    if (reason) {
      // Remove it only if it is still the lock just judged: another waiter
      // may have taken it over and created its own meanwhile.
      const now = snapshot(lockPath);
      if (now && now.text === seen.text && now.mtimeMs === seen.mtimeMs) {
        logger.info(
          { tag: "dep-install", op: "install_lock_stale", lockPath, reason, owner: parseBody(seen.text) },
          "taking over an install lock whose owner is gone",
        );
        removeLock(lockPath);
      }
      // Straight back to the create when the stale lock is gone; if it would
      // not go (or keeps coming back), wait like any other waiter rather than
      // spin on it.
      if (++takeovers <= 3 && !fs.existsSync(lockPath)) continue;
    }
    if (Date.now() - firstTry > maxWaitMs) {
      logger.warn(
        { tag: "dep-install", op: "install_lock_wait_timeout", lockPath, owner: readBody(lockPath), maxWaitMs },
        "gave up waiting on another libi's install of this dependency",
      );
      throw new InstallLockTimeoutError(lockPath, Date.now() - firstTry);
    }
    if (!loggedWait) {
      loggedWait = true;
      logger.info(
        { tag: "dep-install", op: "install_lock_wait", lockPath, owner: readBody(lockPath) },
        "another libi is installing this dependency; waiting for it",
      );
    }
    waited = true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  heldByThisProcess().add(lockPath);
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lockPath, now, now);
    } catch {
      /* best-effort */
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  let released = false;
  return {
    waited,
    release: () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      heldByThisProcess().delete(lockPath);
      // Not a lock that is positively someone else's: one taken over as stale
      // meanwhile (only possible if our heartbeat stopped) belongs to them now.
      const body = readBody(lockPath);
      if (body && (body.pid !== process.pid || body.startedAt !== startedAt)) return;
      removeLock(lockPath);
    },
  };
}

/**
 * Take several locks in a fixed (sorted) order, so two callers asking for
 * overlapping sets cannot deadlock. `waited` is true if any one of them waited.
 */
export async function acquireInstallLocks(
  lockPaths: string[],
  opts: InstallLockOptions = {},
): Promise<InstallLockHandle> {
  const handles: InstallLockHandle[] = [];
  try {
    for (const p of [...new Set(lockPaths)].sort()) handles.push(await acquireInstallLock(p, opts));
  } catch (err) {
    for (const h of handles.reverse()) h.release();
    throw err;
  }
  return {
    waited: handles.some((h) => h.waited),
    release: () => {
      for (const h of [...handles].reverse()) h.release();
    },
  };
}
