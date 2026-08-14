// Crash + abnormal-exit reporting for the Electron MAIN process.
//
// WHY THIS EXISTS
// macOS only writes a DiagnosticReports `.ips` for a HARD native crash
// (SIGSEGV / SIGABRT / SIGTRAP). The cases that actually make the libi window
// "just vanish" leave NO native trace:
//   - a GPU / utility / network subprocess dying (`child-process-gone`)
//   - the renderer going `killed` / `oom` (`render-process-gone`)
//   - an uncaught exception / unhandled rejection in the main process
//   - a plain `app.quit()` (window closed, or the dev parent SIGTERM'd us)
// Previously none of these were logged, so the crash was un-diagnosable. Every
// such path now funnels through `mainSyncLog()` (durable file, always) and —
// in genuine end-user installs — through `reportNativeCrash()` (Sentry).
//
// WHY WE ONLY CAPTURE, NEVER init()
// In packaged builds the Electron main process runs the Next.js server
// in-process, so `instrumentation.ts` → `sentry.server.config.ts` has already
// called `Sentry.init()` in THIS process (with the scrub `beforeSend`). We
// reuse that global client. Initializing a second time here would pull
// `@sentry/node`'s OpenTelemetry auto-instrumentation into the main process and
// risk a double-init, so we deliberately don't. Trade-off: a main-process crash
// that happens BEFORE the Next runtime boots won't reach Sentry — but it IS
// still written to the durable `electron-main-sync.log`.
import * as Sentry from "@sentry/node";

import { SENTRY_ENABLED } from "./config";

export type NativeCrashLevel = "fatal" | "error" | "warning";

export interface NativeCrashOptions {
  /** Human-readable detail (used when there's no Error object). */
  message?: string;
  /** The thrown value, if any — an Error keeps its stack in Sentry. */
  error?: unknown;
  /** Sentry severity. Defaults to "error". */
  level?: NativeCrashLevel;
  /** Structured context (subprocess type, reason, exitCode, …). */
  extra?: Record<string, unknown>;
}

/**
 * Send an Electron-main-process crash / abnormal-exit event to Sentry.
 *
 * No-ops unless Sentry is enabled (real installs only) AND an in-process client
 * already exists. Never throws — safe to call from any lifecycle/crash handler.
 */
export function reportNativeCrash(
  kind: string,
  opts: NativeCrashOptions = {},
): void {
  if (!SENTRY_ENABLED) return;
  try {
    const client = Sentry.getClient();
    // No client yet (e.g. a crash during very early startup, before the Next
    // runtime initialized Sentry in this process). The durable file still has
    // it; there's nothing to send through here.
    if (!client) return;

    const captureContext = {
      level: opts.level ?? "error",
      tags: { source: "electron-main", crash_kind: kind },
      extra: opts.extra,
    } as const;

    if (opts.error instanceof Error) {
      Sentry.captureException(opts.error, captureContext);
    } else if (opts.error !== undefined) {
      Sentry.captureException(
        new Error(`${kind}: ${String(opts.error)}`),
        captureContext,
      );
    } else {
      Sentry.captureMessage(
        `electron-main ${kind}${opts.message ? `: ${opts.message}` : ""}`,
        captureContext,
      );
    }

    // Best-effort flush so the event isn't lost if the process exits right
    // after. Fire-and-forget — never await inside a crash handler. (flush()
    // returns a PromiseLike, so wrap it to get a real .catch.)
    void Promise.resolve(client.flush?.(2000)).catch(() => {});
  } catch {
    /* never throw from a crash handler */
  }
}
