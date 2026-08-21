/**
 * Stop a failed log write from killing the server.
 *
 * When whatever owned our stdout goes away — a closed terminal, a supervising
 * dev harness exiting, an orphaned process whose parent was reaped — the next
 * write to that pipe raises `EPIPE`. Node surfaces it as an `error` event on
 * the stream, and a stream `error` with no listener becomes an
 * `uncaughtException` that takes the process down.
 *
 * In dev that is a hair trigger: Next logs a line per request
 * (`next/dist/server/dev/log-requests.js`), so the very next HTTP request after
 * the pipe closes is enough.
 *
 * Observed on this machine three times (2026-08-04, 2026-08-19, 2026-08-20).
 * The failure mode is worse than a plain crash because it is HALF a shutdown:
 * `bin/libi.js` spawns the server with `stdio: "inherit"`, so the pipe is shared
 * — but only the server dies. The Electron shell survives and keeps retrying a
 * server that is gone, so the app looks *hung* rather than crashed, and
 * `electron-main-sync.log` fills with `ERR_CONNECTION_REFUSED`. Diagnosing it
 * costs far more than the log line was worth.
 *
 * Losing a log line is not a reason to lose the server. `EPIPE` and
 * `ERR_STREAM_DESTROYED` (the same situation once Node has torn the stream
 * down) are swallowed; every other stream error is re-thrown untouched, because
 * a genuinely broken stdout is still worth crashing on.
 *
 * This must be installed in the process that actually SERVES — the tsx child,
 * not `bin/libi.js`, which only spawns it and blocks.
 */

const SILENCED = new Set(["EPIPE", "ERR_STREAM_DESTROYED"]);

let installed = false;

/** Idempotently make stdout/stderr survive a dead pipe. */
export function installStdioResilience(): void {
  if (installed) return;
  installed = true;

  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (err && typeof err.code === "string" && SILENCED.has(err.code)) return;
      throw err;
    });
  }
}

/** Test seam. */
export function resetStdioResilienceForTests(): void {
  installed = false;
  process.stdout.removeAllListeners("error");
  process.stderr.removeAllListeners("error");
}
