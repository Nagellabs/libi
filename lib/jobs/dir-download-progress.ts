/**
 * Byte-level progress for a download whose downloader only tells us about
 * FILES, by watching the destination directory grow.
 *
 * Why this exists: huggingface_hub's `snapshot_download` reports one tqdm tick
 * per completed file, and the ACE-Step repo's files span 639 bytes to 6.61 GB.
 * A file counter therefore sat at 11/12 for 24 minutes while the transformer
 * transferred, and the ETA — computed as (files remaining) x (ms per file) from
 * the small config files — read "1m 12s" the whole time (session 9c3ce4d0,
 * 2026-08-17). Counting bytes makes both the bar and the estimate mean
 * something, because bytes are the thing that actually takes the time.
 *
 * Deliberately observes the filesystem rather than parsing the Python side's
 * per-file byte bars. Those bars are created per in-flight file as
 * `snapshot_download` starts it, so their summed total GROWS during the run and
 * the percentage would move backwards. On-disk bytes against a known expected
 * total is monotonic, and it is also resume-correct for free: files a previous
 * attempt already fetched are on disk and counted, which a fresh set of tqdm
 * bars would not know about.
 */
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

/** Recursive apparent size of `dir`, in bytes. Zero when the directory does not
 *  exist yet — a download reports progress before its destination is created.
 *
 *  Errors on individual entries are swallowed rather than thrown: this races a
 *  live download, so a file can vanish (HF moves completed blobs out of
 *  `.cache/`) between the readdir and the stat. Progress reporting must never
 *  be the thing that fails a 20-minute download. */
export async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await directoryBytes(full);
      } else if (entry.isFile()) {
        total += (await fs.stat(full)).size;
      }
      // Symlinks are skipped on purpose: HF's cache layout can link a blob to
      // its snapshot path, and following both would count the same bytes twice.
    } catch {
      // Entry disappeared mid-walk — see the note above.
    }
  }
  return total;
}

export interface DirDownloadProgress {
  /** Measure now, without waiting for the next interval. Call this when the
   *  underlying downloader reports something, so a completed file shows up
   *  immediately instead of up to `intervalMs` later. */
  poke: () => void;
  /** Stop polling. Idempotent, and safe to call from a `finally`. */
  stop: () => void;
}

/**
 * Poll `dir`'s size and report it as progress until `stop()` is called.
 *
 * `dir` may be a single directory or an array; an array is summed each
 * measurement (an install like tracking-pyenv lands bytes in two places — a
 * venv and a models dir — and only their sum tracks the actual work).
 *
 * `onBytes` receives a MONOTONIC, clamped byte count: never lower than a value
 * already reported, never above `totalBytes`. Both guarantees matter for the
 * ETA — a dip reads as negative progress and poisons the rolling rate, and
 * overshoot would render "104%".
 */
export function trackDirectoryBytes(opts: {
  dir: string | string[];
  totalBytes: number;
  intervalMs?: number;
  onBytes: (bytesDone: number, bytesTotal: number) => void;
}): DirDownloadProgress {
  const { totalBytes, onBytes } = opts;
  const dirs = Array.isArray(opts.dir) ? opts.dir : [opts.dir];
  const intervalMs = opts.intervalMs ?? 1500;
  let highWater = 0;
  let stopped = false;
  let inFlight = false;
  let remeasureRequested = false;

  const measure = async (): Promise<void> => {
    if (stopped) return;
    // One walk at a time — a slow disk must not queue overlapping walks. But a
    // request that arrives mid-walk is COALESCED, never dropped: the walk in
    // flight started before the caller's write, so its result cannot include it,
    // and dropping the request loses that progress until the next interval.
    if (inFlight) {
      remeasureRequested = true;
      return;
    }
    inFlight = true;
    try {
      let seen = 0;
      for (const d of dirs) seen += await directoryBytes(d);
      if (stopped) return;
      const clamped = Math.min(Math.max(seen, highWater), totalBytes);
      if (clamped > highWater || highWater === 0) {
        highWater = clamped;
        onBytes(clamped, totalBytes);
      }
    } catch {
      // Never let progress observation break the work it is observing.
    } finally {
      inFlight = false;
    }
    if (remeasureRequested && !stopped) {
      remeasureRequested = false;
      await measure();
    }
  };

  const timer = setInterval(() => void measure(), intervalMs);
  // Progress polling must never hold the process open — `npx libi` should exit
  // when its work is done, not when a timer happens to fire.
  timer.unref?.();
  void measure(); // report the resume baseline immediately

  return {
    poke: () => void measure(),
    stop: () => {
      stopped = true;
      remeasureRequested = false;
      clearInterval(timer);
    },
  };
}
