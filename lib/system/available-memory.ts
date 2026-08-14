import os from "os";
import { execFileSync } from "child_process";

/**
 * Cross-platform "available memory" — what the kernel can hand to a new
 * allocation right now, including reclaimable cache pages.
 *
 * `os.freemem()` on macOS only reports *truly free* pages (the `free`
 * column of `vm_stat`). The kernel keeps gigabytes in `inactive` /
 * `speculative` / `purgeable` buckets that it reclaims instantly when
 * something allocates. On a healthy 48 GB Mac you can easily see
 * `os.freemem()` report 2 GB while ~17 GB is actually reclaimable —
 * which made the ACE-Step pre-flight check refuse to run on machines
 * that could comfortably handle it. See bin-deps QA, May 2026.
 *
 * Strategy:
 * - darwin:  parse `vm_stat` and sum free+inactive+speculative+purgeable.
 *            Falls back to `os.freemem()` if parsing fails for any reason.
 * - linux:   `os.freemem()` already includes the buffer/cache reclaimable
 *            via /proc/meminfo's MemAvailable approximation libuv exposes.
 * - win32:   `os.freemem()` is "physical free" which is the right knob.
 */
export function getAvailableMemoryBytes(): number {
  if (process.platform !== "darwin") {
    return os.freemem();
  }
  return getDarwinAvailableMemoryBytes() ?? os.freemem();
}

/** Exported for tests — parses `vm_stat` output (or any string in that
 *  format) into a byte count. Returns `null` on any parse failure so
 *  callers can fall back to `os.freemem()`. */
export function parseVmStatAvailable(vmStat: string): number | null {
  // The header line tells us the page size, e.g.:
  //   "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
  // Apple Silicon ships 16 KB pages; older Intel Macs ship 4 KB. We
  // don't want to hard-code either.
  const pageSizeMatch = /page size of (\d+) bytes/.exec(vmStat);
  if (!pageSizeMatch) return null;
  const pageSize = Number(pageSizeMatch[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;

  const read = (label: string): number | null => {
    // `Pages free:                               62505.`
    const m = new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(vmStat);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  };

  const free = read("free");
  const inactive = read("inactive");
  const speculative = read("speculative");
  const purgeable = read("purgeable");
  // Missing free is fatal; the rest can be zero on minimal builds but
  // they're always present on real macOS hosts. Be permissive about
  // missing ones — count what we have.
  if (free == null) return null;
  const pages = free + (inactive ?? 0) + (speculative ?? 0) + (purgeable ?? 0);
  return pages * pageSize;
}

function getDarwinAvailableMemoryBytes(): number | null {
  try {
    const stdout = execFileSync("/usr/bin/vm_stat", [], {
      encoding: "utf8",
      timeout: 2_000,
    });
    return parseVmStatAvailable(stdout);
  } catch {
    return null;
  }
}
