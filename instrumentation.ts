// Next.js compiles this file for BOTH Node.js and Edge runtimes. The Edge
// bundler walks every static + `import("string-literal")` reference even
// though the body is gated to NEXT_RUNTIME === "nodejs" — which historically
// pulled `playwright-core` (and its `chromium-bidi` native bits) through
// the proxy/runner chain and broke the build. Anything Node-only must be
// loaded via dynamic import inside the runtime guard.
//
// Category B (DB migration, agent warm-up, standby session) runs HERE in
// the Next.js process. Category A (bundled-MCP installs + probe) ran in
// the CLI parent before this process was spawned — so by the time this
// runs, every bundled MCP's deps are guaranteed on disk.
import * as Sentry from "@sentry/nextjs";

export async function register(): Promise<void> {
  // `~/.libi/logs/server.log` — Next.js' OWN output (compile errors, request
  // lines, runtime exceptions, `[browser]`-relayed React errors) routed through
  // pino by `next-logger`, whose pino factory lives in `next-logger.config.js`
  // at the package root (discovered by lilconfig from `process.cwd()`, which is
  // the repo root in dev and the runtime root in a packaged/installed app).
  //
  // This dynamic import is the ONLY thing that activates it. `next-logger` is a
  // preload-style patcher: having it in `dependencies`, in `serverExternalPackages`,
  // and having the config file on disk does nothing on its own — for a long
  // while all three were true and `server.log` was never created in ANY
  // environment, so every diagnostic that pointed at that file pointed at
  // nothing. Loading it from `register()` is the activation path Next documents,
  // and it must stay FIRST so console output emitted by later boot steps is
  // already being captured.
  //
  // Wrapped because logging must never break boot (same discipline as
  // `lib/logger.ts`): the config file opens a file descriptor under LIBI_HOME,
  // which can fail on a read-only/permission-denied home.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      await import("next-logger");
    } catch (err) {
      process.stderr.write(
        `[instrumentation] next-logger failed to load — server.log will not be written: ${
          (err as Error)?.message ?? err
        }\n`,
      );
    }
  }

  // Sentry: initialize server-side capture. libi is a local Node/Electron app
  // with no Edge-runtime routes, so only the nodejs config is loaded (the
  // dynamic import is gated by NEXT_RUNTIME, the same discipline the boot
  // lifecycle below relies on). Client capture is wired via
  // instrumentation-client.ts.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  // Everything below is Node-only boot lifecycle (Category B). The Edge
  // runtime must never reach it.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Register built-in script providers early so the JobManager runner can
  // find them without ordering issues. This is idempotent — safe to call
  // again from the runner as a safety net.
  const { registerBuiltinScriptProviders } = await import(
    "./lib/analysis/script-providers/register"
  );
  registerBuiltinScriptProviders();

  try {
    const { runBootPhase } = await import("./lib/server/lifecycle");
    // Lifecycle events flow into the SSE event bus via `lifecycleEvents`;
    // a no-op adapter satisfies the signature without duplicating output.
    const result = await runBootPhase({ adapter: { onEvent: () => {} } });
    if (!result.ok) {
      const { serverLogger } = await import("./lib/logger");
      serverLogger.error(
        { tag: "lifecycle", op: "boot_phase_failed", fatal: result.fatal },
        "Boot phase failed — UI will show fatal banner",
      );
    }
  } catch (err) {
    const { serverLogger } = await import("./lib/logger");
    serverLogger.warn(
      { tag: "lifecycle", op: "instrumentation_failed", err },
      "Boot phase threw outside the structured error path",
    );
  }

  // Analytics: ensure the per-install UUID exists and record first_launch once
  // (GA4 system). MUST run after runBootPhase — the settings table only exists
  // once Category B's db-migrate step has run (fresh installs have no tables).
  // Wrapped — analytics must never break boot.
  try {
    const { getOrCreateAnalyticsUserId, markAnalyticsMilestoneOnce } = await import(
      "./lib/db/settings"
    );
    getOrCreateAnalyticsUserId();
    if (markAnalyticsMilestoneOnce("launch")) {
      const { trackServerEvent } = await import("./lib/analytics/server");
      void trackServerEvent("first_launch");
    }
  } catch (err) {
    const { serverLogger } = await import("./lib/logger");
    serverLogger.warn({ tag: "analytics", op: "boot_init_failed", err }, "Analytics boot init failed");
  }

  const { startStorageWatcher } = await import("./lib/storage-watch/watcher");
  await startStorageWatcher();
}

// Automatically captures all unhandled server-side request errors (App Router
// route handlers, server components, server actions). Requires @sentry/nextjs
// >= 8.28.0. Identity/secret scrubbing is applied via the configs' beforeSend.
export const onRequestError = Sentry.captureRequestError;
