/**
 * Lifecycle event vocabulary for libi's two-phase startup.
 *
 * Category A runs in the CLI parent process (or Electron main process)
 * BEFORE Next.js is spawned. It installs every bundled MCP's npm package
 * + binary deps, then verifies each MCP with an in-memory probe. On any
 * failure, A emits a `fatal` event with an actionable hint and the CLI
 * exits.
 *
 * Category B runs in the Next.js process (or the Electron main process
 * for in-process Electron builds). It assumes Category A has already
 * completed successfully — every bundled MCP's deps are on disk and
 * have been probe-verified.
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
   * resolve by force-quitting — the most plausible way to end up with the
   * half-installed tree `lib/agents/claude-native-binary.ts` exists to detect.
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

/** Emitted when Category A starts probing a single MCP. */
export interface CategoryAProbeStartEvent {
  kind: "category-a-probe-start";
  mcpId: string;
  label: string;
}

/** Emitted when a probe finishes. */
export interface CategoryAProbeDoneEvent {
  kind: "category-a-probe-done";
  mcpId: string;
  label: string;
  status: "up" | "down" | "skipped";
  /** Reason when status === "skipped" (e.g. "needs_config"). */
  reason?: string;
  durationMs: number;
}

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
  | CategoryAProbeStartEvent
  | CategoryAProbeDoneEvent
  | CategoryADoneEvent
  | CategoryBStepEvent
  | CategoryBDoneEvent
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
