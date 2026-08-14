// lib/runtime/shell-update.ts
//
// The DESKTOP SHELL's own update channel, seen from inside the runtime.
//
// ## Why this exists next to update-check.ts
//
// `update-check.ts` answers "is there a newer `@nagellabs/libi` on npm?" —
// the runtime cadence, installable in place by the running app. This module
// covers the OTHER cadence: a new Electron shell on GitHub Releases (Chromium
// CVEs, ABI bumps, `shellApiVersion` breaks). The runtime cannot drive that
// update itself — checking the feed, downloading the .zip and swapping the
// .app are all electron-updater work that only the MAIN PROCESS can do — so
// the shell registers a small bridge here at boot and the update route reads
// it. No bridge registered (a dev tree, an `npx` install, a pre-updater
// shell) simply means "no shell update channel", never an error.
//
// ## Why a `globalThis` slot and not a module variable
//
// Same two reasons as `lib/server/lifecycle/relaunch.ts`, which this pattern
// is copied from: the REGISTRANT (electron/main.ts via shell-api) loads the
// compiled `dist-cli` copy of this module while the API route gets its own
// Turbopack-bundled copy (instance split), and a module-level `let` nothing
// in the route's bundle graph ever assigns is provably null and gets
// dead-code-eliminated. An opaque `globalThis` property survives both.

/**
 * The shell updater's lifecycle, flattened to what the UI needs. Terminal
 * download states are deliberately absent: a finished download restarts the
 * app moments later (`electron/shell-updater.ts`), so "ready" is the last
 * phase a poll can observe.
 */
export type ShellUpdatePhase =
  /** No check has completed yet. */
  | "idle"
  | "checking"
  | "up-to-date"
  /** A newer shell exists on the feed. Offerable. */
  | "update-available"
  | "downloading"
  /** Downloaded and verified; the shell is about to quit-and-install. */
  | "ready"
  /** The last check or download failed. SILENT in the UI, like `unknown`. */
  | "error";

export interface ShellUpdateStatus {
  phase: ShellUpdatePhase;
  /** The running shell's own version (`app.getVersion()`). */
  currentVersion: string;
  /** Newest version on the feed, once a check has succeeded. */
  latestVersion: string | null;
  /** 0–100 while downloading, else null. */
  percent: number | null;
  /** Failure detail for `phase: "error"` — logged, never rendered. */
  error: string | null;
  /** When the last check finished (epoch ms), or null before the first. */
  checkedAt: number | null;
}

export interface ShellUpdater {
  getStatus(): ShellUpdateStatus;
  /**
   * Hit the feed now. Resolves when the check settles (either way); the
   * route awaits this for `?force=1` so "Check again" returns fresh state.
   */
  checkNow(): Promise<void>;
  /**
   * Download the advertised update. The click that calls this is the consent
   * for the restart that follows — once verified on disk, the shell
   * quits-and-installs on its own (`electron/shell-updater.ts`), so there is
   * no separate "restart" call to forget.
   */
  download(): void;
}

const slot = globalThis as unknown as { __libiShellUpdater?: ShellUpdater | null };

/** Called by the shell (via shell-api) once electron-updater is wired up. */
export function registerShellUpdater(updater: ShellUpdater): void {
  slot.__libiShellUpdater = updater;
}

/** Read by `/api/runtime/update`. Null = no shell update channel here. */
export function getShellUpdater(): ShellUpdater | null {
  return slot.__libiShellUpdater ?? null;
}
