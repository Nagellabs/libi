/**
 * Shared logger for both the MCP stdio process and the Next.js server.
 *
 * Writes raw JSON (one record per line) to ~/.libi/logs/libi.log.
 *
 * For human-readable output, pipe through pino-pretty on demand:
 *
 *   tail -f ~/.libi/logs/libi.log | npx pino-pretty
 *   tail -f ~/.libi/logs/libi.log | jq 'select(.tag == "ffmpeg")'
 *
 * Two child loggers distinguish the source:
 *
 *   import { mcpLogger } from "@/lib/logger";   // MCP stdio process
 *   import { serverLogger } from "@/lib/logger"; // Next.js server
 *
 *   mcpLogger.info("tool call completed");
 *   serverLogger.info("workspace prepared");
 *
 * ## Why no `transport`
 *
 * pino's `transport: { target: "pino-pretty" }` spawns a worker thread
 * that loads `pino-pretty` by string name. Next 16's Turbopack rewrites
 * `require("pino")` inside the bundled server to a synthetic
 * content-hashed name (`pino-28069d5257187539`) — even when `pino` is
 * in `serverExternalPackages` — and the worker then crashes with
 * `Cannot find module 'pino-28069d5257187539'` at boot. Writing JSON
 * directly to a file descriptor via `pino.destination` avoids the
 * transport worker entirely, so the Turbopack rewrite never bites.
 *
 * Trade-off: log file is no longer pretty-formatted text. Pipe through
 * `npx pino-pretty` when reading.
 */

import fs from "fs";
import path from "path";
import pino from "pino";
import { ensureLibiDirs, getLibiLogDir } from "@/lib/libi-home";

/**
 * ## Where the log file is resolved, and when
 *
 * This module used to resolve `<LIBI_HOME>/logs/libi.log` (and call
 * `ensureLibiDirs()`) at MODULE SCOPE unconditionally. In the packaged Electron
 * MAIN process that is too early: `electron/main.ts` can only learn its data
 * root from `app.getPath("userData")` inside its module body, but ES import
 * bindings are hoisted, so every transitively-imported module — this one
 * included — is fully evaluated before that assignment runs. The result was the
 * whole of Category A logging into the DEVELOPER's `~/.libi` instead of the
 * app's own home (and creating `~/.libi/logs` on a machine that had no CLI
 * install at all).
 *
 * The fix is scoped to exactly that process, and does not depend on import
 * order to work:
 *
 *   - In the Electron main process the path is resolved on FIRST WRITE, so it
 *     sees whatever `LIBI_HOME` the app has declared by the time it actually
 *     logs (`electron/libi-home-bootstrap.ts` publishes it as the very first
 *     import, and `main.ts` re-asserts it — but even if both moved, no log line
 *     is emitted before Category A, which runs later still).
 *   - Everywhere else — the Next.js server, the MCP stdio child, the CLI, tests
 *     — the path is resolved at import exactly as before. Those processes
 *     inherit `LIBI_HOME` from their parent's environment, so there is nothing
 *     to wait for; deferring there would only move the resolution into whatever
 *     transient `LIBI_HOME` happened to be set when the first line was logged.
 *
 * In BOTH cases the destination is opened once and never chases later
 * `LIBI_HOME` changes: a chase-the-env destination materializes a log file
 * inside every short-lived home a process ever points at, for no benefit.
 */

/** True only in the Electron MAIN process (the renderer reports `"renderer"`). */
function isElectronMainProcess(): boolean {
  return (
    Boolean(process.versions.electron) &&
    (process as NodeJS.Process & { type?: string }).type === "browser"
  );
}

const deferLogPathResolution = isElectronMainProcess();

// Preserve the historical import-time side effect for every non-Electron-main
// process; the Electron main process does it in `openDestination()` instead,
// once its real home is known.
if (!deferLogPathResolution) ensureLibiDirs();
const importTimeLogPath = deferLogPathResolution
  ? null
  : path.join(getLibiLogDir(), "libi.log");

let destination: ReturnType<typeof pino.destination> | null = null;

function openDestination(): ReturnType<typeof pino.destination> {
  if (deferLogPathResolution) ensureLibiDirs();
  const logPath = importTimeLogPath ?? path.join(getLibiLogDir(), "libi.log");

  // Rotate: truncate if over 1MB
  try {
    const stat = fs.statSync(logPath);
    if (stat.size > 1_000_000) fs.truncateSync(logPath, 0);
  } catch { /* doesn't exist yet */ }

  // `sync: false` batches writes via setImmediate so we don't block the
  // event loop on every log. The file is still flushed at exit.
  const dest = pino.destination({ dest: logPath, append: true, sync: false, mkdir: true });

  // The async destination opens its fd off the main thread. If that open —
  // or any later write — fails (log dir deleted, disk full, EMFILE), SonicBoom
  // emits 'error'; with no listener that becomes an uncaughtException and
  // takes the whole process down. Logging must never kill the server: report
  // to stderr and keep running (subsequent log lines are dropped).
  dest.on("error", (err: Error) => {
    try {
      process.stderr.write(`[libi-logger] log destination error (logs dropped): ${err?.message ?? err}\n`);
    } catch {
      /* stderr gone too — nothing left to do */
    }
  });
  return dest;
}

/**
 * The stream pino writes through. Opening is deferred to the first write (see
 * above) and every failure is swallowed: a `logger.info()` that THROWS turns a
 * healthy request into a 500 for no reason a caller could act on. SonicBoom
 * throws synchronously once its target is gone (a deleted log directory), which
 * `dest.on("error")` alone does not cover.
 */
const lazyDestination = {
  write(msg: string): void {
    const dest = getDestination();
    if (!dest) return; // latched failure — see getDestination(); nothing to write to
    try {
      dest.write(msg);
    } catch (err) {
      try {
        process.stderr.write(
          `[libi-logger] log write failed (line dropped): ${(err as Error)?.message ?? err}\n`,
        );
      } catch {
        /* stderr gone too — nothing left to do */
      }
    }
  },
};

/**
 * M7: `openDestination()` can throw SYNCHRONOUSLY (e.g. `mkdir: true`'s
 * internal `fs.mkdirSync` hitting EACCES/EROFS on a read-only or
 * permission-denied log dir). Before this latch, a throw there left
 * `destination` null forever, so EVERY subsequent `logger.info()` re-ran
 * `ensureLibiDirs()` + `fs.statSync()` + `pino.destination()` (all real
 * syscalls) plus a stderr write — on the hot logging path, for the lifetime
 * of the process. `destinationFailed` makes the retry happen exactly once:
 * after that, every write is a single boolean check that short-circuits to
 * "drop it", identical in effect (logs still lost) but without repeating the
 * failed I/O on every line.
 */
let destinationFailed = false;

function getDestination(): ReturnType<typeof pino.destination> | null {
  if (destination) return destination;
  if (destinationFailed) return null;
  try {
    destination = openDestination();
    return destination;
  } catch (err) {
    destinationFailed = true;
    try {
      process.stderr.write(
        `[libi-logger] failed to open log destination (logging to stderr only from now on): ${(err as Error)?.message ?? err}\n`,
      );
    } catch {
      /* stderr gone too — nothing left to do */
    }
    return null;
  }
}

/**
 * Backstop redaction for the whole logger, on top of (never instead of)
 * scrubbing at each call site — e.g. `lib/codex-config/codex-cli.ts`'s `run()`
 * routes a codex failure message through `scrubSecrets` before it ever
 * reaches `logger.warn`. Call sites can't all be trusted to remember that, so
 * pino's own `redact` catches whatever a log call passes under one of these
 * KEY names, no matter how deep — `wildcard` matches exactly one path
 * segment, so each carrier is listed at a few likely nesting depths rather
 * than relying on a single level. `sentry.server.config.ts`'s comment above
 * `enableLogs: true` names this as already configured; this is what makes
 * that true.
 */
const REDACT_KEYS = [
  "env",
  "headers",
  "apiKey",
  "token",
  "authorization",
  "Authorization",
  "secret",
  "password",
  "credential",
  "cookie",
];
const redactPaths = REDACT_KEYS.flatMap((key) => [
  key,
  `*.${key}`,
  `*.*.${key}`,
  `*.*.*.${key}`,
]);

const baseLogger = pino(
  {
    level: "trace",
    // ISO 8601 with millis — matches the pretty-printed timestamp we
    // used to emit, just in machine-parseable form.
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    redact: {
      paths: redactPaths,
      censor: "[redacted]",
    },
  },
  lazyDestination,
);

/** Logger for code running in the MCP stdio process */
export const mcpLogger = baseLogger.child({ name: "mcp" });

/** Logger for code running in the Next.js server process */
export const serverLogger = baseLogger.child({ name: "server" });

/**
 * Logger for every ffmpeg subprocess invocation. Tags output with
 * `tag: "ffmpeg"` so a developer can grep `~/.libi/logs/libi.log` for
 * every call site.
 */
export const ffmpegLogger = baseLogger.child({ tag: "ffmpeg" });

/**
 * Logger for MediaBunny interactions. Reserved for Plan 5.
 */
export const mediabunnyLogger = baseLogger.child({ tag: "mediabunny" });

/**
 * Logger for the proxy-generation pipeline. Tags with `tag: "proxy"` so
 * a developer can grep `~/.libi/logs/libi.log` for every state transition:
 *
 *   tail -f ~/.libi/logs/libi.log | jq 'select(.tag == "proxy")'
 */
export const proxyLogger = baseLogger.child({ tag: "proxy" });

/**
 * Logger for export-pipeline events. Tags with `tag: "export"` so a
 * developer can grep the exact journey of an export:
 *
 *   tail -f ~/.libi/logs/libi.log | jq 'select(.tag == "export" or (.tag == "ffmpeg" and (.op | startswith("export_"))))'
 */
export const exportLogger = baseLogger.child({ tag: "export" });

/**
 * Logger for direct-manipulation overlay events — UI edits (open / commit /
 * cancel) and MCP tool mutations (add / update / remove / reorder). Tags
 * with `tag: "overlay"` so you can tail the shared log and see exactly
 * what the user clicked and what the agent changed:
 *
 *   tail -f ~/.libi/logs/libi.log | jq 'select(.tag == "overlay")'
 */
export const overlayLogger = baseLogger.child({ tag: "overlay" });

/**
 * Logger for video script analysis pipeline. Tags with `tag: "script-analysis"`
 * so you can grep the script analysis workflow:
 *
 *   tail -f ~/.libi/logs/libi.log | jq 'select(.tag == "script-analysis")'
 */
export const scriptAnalysisLogger = baseLogger.child({ tag: "script-analysis" });

// Capture unhandled errors. Do NOT exit — Next.js routes are isolated, and
// a crash in one shouldn't take down the SSE bus, the agent process, or
// every active session. If the dev server's underlying state is genuinely
// unrecoverable, Next.js will surface it via the route-level error boundary.
process.on("uncaughtException", (err) => {
  // Throwing from an uncaughtException handler is instantly fatal to the
  // process (Node treats it as a double fault) — so a broken log
  // destination must never escape this handler.
  try {
    baseLogger.fatal({ err }, "Uncaught exception (continuing)");
  } catch {
    try {
      process.stderr.write(`[libi-logger] uncaught exception (log write failed): ${err?.stack ?? err}\n`);
    } catch {
      /* nothing left to report to */
    }
  }
});

process.on("unhandledRejection", (reason) => {
  try {
    baseLogger.fatal({ reason: String(reason) }, "Unhandled rejection (continuing)");
  } catch {
    try {
      process.stderr.write(`[libi-logger] unhandled rejection (log write failed): ${String(reason)}\n`);
    } catch {
      /* nothing left to report to */
    }
  }
});
