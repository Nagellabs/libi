// lib/export/chromium-size.ts
//
// How big the Chromium download is, in the units the user sees. A LEAF on
// purpose — no imports — because two client-reachable modules need the same
// number as the server: `mcp/registry/bundled.ts` (the `libi-export` row's
// description, imported by the Settings UI) and
// `components/settings/dependency-chip.tsx` (the Download button's tooltip).
// `lib/export/ensure-chromium.ts` spawns a child process and cannot be
// imported by either; it re-exports these so server callers keep one import.
//
// Units: Playwright reports its archives in MiB (2^20 bytes —
// `browserFetcher.js#toMegabytes` divides by 1024 twice and prints "MiB").
// libi says "MB" everywhere, and means it: decimal megabytes, 1,000,000
// bytes. The conversion happens once, at the parser boundary
// (`parsePlaywrightProgressLine`), so the agent's disclosure, the job's
// progress bar and the Settings chip all agree. Labelling MiB as "MB" is what
// what a review caught: a "~165 MB" disclosure followed by a bar that
// climbed to 166.

/** Playwright's own figure for the chromium archive (`165.1 MiB` on 1.59.1). */
export const CHROMIUM_DOWNLOAD_MIB = 165;

/** MiB → decimal MB. Exact, not rounded — callers round for display. */
export function mibToMb(mib: number): number {
  return (mib * 1024 * 1024) / 1_000_000;
}

/** What the agent and the UI disclose before starting: "~173 MB". Approximate
 *  by construction (the real total is read off Playwright's output and
 *  reported per tick), but derived through the SAME conversion as those ticks,
 *  so the two round to the same number. */
export const CHROMIUM_DOWNLOAD_MB = Math.round(mibToMb(CHROMIUM_DOWNLOAD_MIB));
