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
 * The shell updater's lifecycle, flattened to what the UI needs.
 *
 * Since the auto-download change, "ready" is a STABLE state: the download
 * happened on its own and the shell waits for an explicit restart — either
 * the UI's "Restart to apply" (`restart()`) or the user's next normal quit
 * (`autoInstallOnAppQuit`). Shells that predate auto-download restart
 * themselves moments after "ready"; `ShellUpdateStatus.autoDownload` is how
 * the UI tells the two generations apart.
 */
export type ShellUpdatePhase =
  /** No check has completed yet. */
  | "idle"
  | "checking"
  | "up-to-date"
  /** A newer shell exists on the feed. Offerable. */
  | "update-available"
  | "downloading"
  /** Downloaded and verified; waiting for a restart to apply it. */
  | "ready"
  /**
   * An update exists, and this installation cannot apply it — it is running
   * from somewhere its own bundle can't be replaced (translocated, off a
   * disk image, a read-only or administered location). Nothing was
   * downloaded, and nothing will be until the user moves the app.
   *
   * DELIBERATELY not `error`: `error` is documented as silent, and this is
   * the one update state the user has to be told about, because it is the
   * one they have to fix themselves. See `electron/self-update-probe.ts`.
   */
  | "blocked"
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
  /**
   * Why the bundle can't be replaced. Set only with `phase: "blocked"`, and
   * only to choose which advice to show — the verdict came from a write
   * probe, not from this.
   */
  blockedReason?:
    | "translocated"
    | "running-from-dmg"
    | "not-in-applications"
    | "read-only-location"
    | null;
  /**
   * Where the app is running from, shown to the user VERBATIM. It is the
   * evidence, and the difference between an abstract message and one they
   * can act on.
   */
  blockedPath?: string | null;
  /**
   * True when this shell downloads updates on its own and waits at "ready"
   * for an explicit restart. Absent (old shells): downloads start only from
   * a click, and the shell restarts itself once the download is verified —
   * the UI must keep the click-to-install offer for those.
   */
  autoDownload?: boolean;
}

export interface ShellUpdater {
  getStatus(): ShellUpdateStatus;
  /**
   * Hit the feed now. Resolves when the check settles (either way); the
   * route awaits this for `?force=1` so "Check again" returns fresh state.
   */
  checkNow(): Promise<void>;
  /**
   * Download the advertised update. On auto-download shells this is a
   * back-compat entry point: it is a no-op while a download runs, and when
   * the download is already `ready` it is treated as restart consent (so an
   * old runtime's "Install & restart" click still applies the update on a
   * new shell). On pre-auto-download shells, the click that calls this is
   * the consent for the self-restart that follows the download.
   */
  download(): void;
  /**
   * Quit and install the `ready` download now. Only auto-download shells
   * register this; callers must fall back to `download()` when absent.
   */
  restart?(): void;
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
