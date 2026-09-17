/**
 * Lifecycle event vocabulary for libi's two-phase startup.
 *
 * Category A runs in the CLI parent process (or Electron main process)
 * BEFORE Next.js is spawned. It installs the tier-1 binary set — a spawnable
 * Node.js runtime, ffmpeg and ffprobe. On any failure, A emits a `fatal`
 * event with an actionable hint and the CLI exits.
 *
 * Category B runs in the Next.js process (or the Electron main process
 * for in-process Electron builds). It assumes Category A has already
 * completed successfully — the tier-1 deps are on disk.
 */

/** A unit of work in Category A — one MCP package or one binary dep. */
export interface InstallItem {
  /** Stable id, e.g. "youtube-downloader" or "ffmpeg". */
  id: string;
  /** Human-friendly label, e.g. "YouTube Downloader" or "ffmpeg". */
  label: string;
  /** Whether this item is an npm package install or a binary download. */
  kind: "npm" | "binary";
}

/** Emitted when Category A starts a single install item. */
export interface CategoryAInstallStartEvent {
  kind: "category-a-install-start";
  item: InstallItem;
}

/** Emitted periodically while an install is in flight. */
export interface CategoryAInstallProgressEvent {
  kind: "category-a-install-progress";
  item: InstallItem;
  bytesDownloaded: number;
  bytesTotal: number | null;
  /**
   * Renderer-ready status text, used INSTEAD of the byte counts when present.
   *
   * Byte-level progress is only available for downloads libi performs itself
   * (the binary-dep phase). An `npm install` is opaque — it reports nothing
   * until it exits — yet the adapter's is the single largest download in
   * Category A (~345MB) and can legitimately run for minutes. Without a tick
   * the UI sits motionless on "running" and reads as a hang, which users
   * resolve by force-quitting — the most plausible way to end up with a
   * half-installed adapter tree.
   */
  detail?: string;
}

/**
 * Emitted when a single install item finishes (success, skip, or a
 * non-fatal failure). "failed" exists ONLY for items whose install phase is
 * allowed to fail without aborting Category A (currently: the Claude
 * adapter) — every other item either succeeds/skips or throws
 * `InstallPhaseError`, which ends the boot sequence via a separate `fatal`
 * event instead of this one.
 */
export interface CategoryAInstallDoneEvent {
  kind: "category-a-install-done";
  item: InstallItem;
  result: "installed" | "skipped" | "failed";
  /**
   * Human-friendly reason when result === "skipped" (e.g. "already at
   * 0.8.4") or result === "failed" (the real install/verification
   * diagnostic).
   */
  reason?: string;
}

// There is no `category-a-probe-*` event any more. Category A's phase 3
// — an in-memory `initialize` round-trip against each bundled MCP — was deleted
// on 2026-09-08 along with the bundled MCPs themselves, and nothing has emitted
// a probe event since. The two kinds outlived it as declarations with handlers
// in the CLI adapter and the Electron splash, which read as a working feature
// and were not one. Deleted together; `category-b-step` renders boot progress.

/** Category A reached a terminal success state. */
export interface CategoryADoneEvent {
  kind: "category-a-done";
  durationMs: number;
}

/** Category B's individual steps still use simple step ids. */
export type CategoryBStepId =
  | "db-migrate"
  | "jobs-recover"
  | "port-file"
  | "mcp-http"
  | "agent-warm"
  | "standby-create"
  | "probe-persist";

export interface CategoryBStepEvent {
  kind: "category-b-step";
  step: CategoryBStepId;
  status: "running" | "done";
}

export interface CategoryBDoneEvent {
  kind: "category-b-done";
  durationMs: number;
}

/**
 * Something did not work, and boot carries on without it. Unlike `fatal`, the
 * prelude does not stop: the adapter shows `message` wherever the user is
 * looking while libi starts, and the feature's own surface in the app is where
 * it gets fixed. A step that warned must not also render as a plain success.
 */
export interface WarningEvent {
  kind: "warning";
  phase: "category-b";
  step: CategoryBStepId;
  /** One line of user-facing copy that says what is missing and where to fix it. */
  message: string;
}

/** Fatal terminates the prelude. `hint` is the actionable copy. */
export interface FatalEvent {
  kind: "fatal";
  phase: "category-a" | "category-b";
  /** Identifier for the step / item that failed (free-form). */
  step: string | null;
  error: string;
  /** Multi-line user-facing hint, e.g. "Check your network connection". */
  hint: string;
}

export interface PreludeStartEvent {
  kind: "prelude-start";
}

export interface ServerListeningEvent {
  kind: "server-listening";
  url: string;
}

export type LifecycleEvent =
  | PreludeStartEvent
  | CategoryAInstallStartEvent
  | CategoryAInstallProgressEvent
  | CategoryAInstallDoneEvent
  | CategoryADoneEvent
  | CategoryBStepEvent
  | CategoryBDoneEvent
  | WarningEvent
  | FatalEvent
  | ServerListeningEvent;

export interface LifecycleAdapter {
  onEvent(event: LifecycleEvent): void;
}

export interface InstallPhaseResult {
  ok: boolean;
  fatal?: { phase: "category-a"; step: string | null; error: string; hint: string };
}

export interface BootPhaseResult {
  ok: boolean;
  fatal?: { phase: "category-b"; step: CategoryBStepId | null; error: string; hint: string };
}
