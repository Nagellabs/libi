/**
 * HTTP MCP aggregator entry point. Spawned by the libi lifecycle
 * (`lib/server/lifecycle/mcp-http-child.ts`); also runnable by hand:
 *   LIBI_MCP_PORT=3457 tsx mcp/http/index.ts   ·   npx libi serve-mcp-http
 * Serves libi's own tools, and nothing else, on
 * http://127.0.0.1:<port>/mcp. Logs through `mcpLogger` to
 * ~/.libi/logs/libi.log, tag mcp-http. The one line it ever writes to stderr
 * is the cause of a failed startup (see `reportStartupFailure`).
 */
import { mcpLogger as logger } from "@/lib/logger";
import { ensureLibiDirs, MCP_HEALTH_TOKEN_ENV, resolveMcpHttpPort } from "@/lib/libi-home";
import { redactCliOutput, scrubSecrets } from "@/lib/security/secret-scrub";
import { startMcpHttpServer } from "@/mcp/http/server";

/**
 * How long a shutdown may take before the process exits regardless. Closing
 * sessions can wedge on one that never settles, and once the supervisor is
 * gone nothing is left to send the SIGKILL that used to end such a process.
 */
const FORCED_EXIT_MS = 5_000;

/** Longest startup-failure line written to stderr. */
const STARTUP_FAILURE_MAX = 300;

/**
 * This launch's `/healthz` token, kept only so a startup failure can be
 * scrubbed of it. Read from the environment before anything that can fail.
 */
const launchHealthToken = process.env[MCP_HEALTH_TOKEN_ENV] || undefined;
delete process.env[MCP_HEALTH_TOKEN_ENV];

/**
 * Put the cause of a failed startup where the supervisor can see it: one line
 * on stderr, which it captures and quotes in its gave-up report.
 *
 * `mcpLogger` cannot do this. It writes to the log file only (stderr is its
 * fallback when that file cannot be opened), so the supervisor's report used
 * to say the endpoint "printed nothing" when the real cause, such as a pinned
 * port someone else holds, was sitting in a different process's log. Only the
 * error's code and the first line of its message are written, masked of the
 * health token and of bearer and long `=value` shapes; never its stack or
 * anything from the environment.
 */
function reportStartupFailure(err: unknown): void {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" ? `${e.code} ` : "";
  const message = (typeof e?.message === "string" ? e.message : String(err)).split(/\r?\n/)[0];
  const cause = redactCliOutput(scrubSecrets(`${code}${message}`, launchHealthToken ? [launchHealthToken] : []));
  try {
    process.stderr.write(`[libi mcp-http] failed to start: ${cause.slice(0, STARTUP_FAILURE_MAX)}\n`);
  } catch {
    /* stderr gone — the log line is all that is left */
  }
}

async function main() {
  ensureLibiDirs();
  const port = resolveMcpHttpPort();
  // It identifies this process to the supervisor that launched it, and nothing
  // this process spawns needs it, so it is already out of the environment.
  // Never logged.
  const healthToken = launchHealthToken;

  // A supervisor that SIGTERMs twice (or SIGINT then SIGTERM) must not run the
  // shutdown twice — the second pass would close already-closed sessions and
  // could reject where the first one is still mid-flight.
  let stopping = false;
  let close: (() => Promise<void>) | null = null;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => {
      logger.warn({ tag: "mcp-http", op: "stop_forced_exit", waitedMs: FORCED_EXIT_MS }, "shutdown did not finish in time; exiting");
      process.exit(0);
    }, FORCED_EXIT_MS).unref();
    try {
      await close?.();
    } catch (err) {
      // A shutdown that cannot finish still has to end the process; exiting
      // non-zero here would only make the supervisor treat a clean stop as a
      // crash.
      logger.error({ err, tag: "mcp-http", op: "stop_failed" }, "shutdown did not complete cleanly");
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void stop());
  // Under npx the supervised child shares the terminal's process group, so a
  // Ctrl-C reaches it at the same moment it reaches libi. Exiting on it races
  // libi's own stop: when libi's event loop is busy, the exit is seen before
  // the stop is, and is counted as a crash (a false "gave up" once the restart
  // budget is spent). So a supervised launch leaves Ctrl-C to libi, which
  // SIGTERMs this process; if libi dies instead, stdin closes and ends it
  // below. Registering a handler is what suppresses the default exit. A run by
  // hand has no one else to stop it and still exits on Ctrl-C.
  process.on("SIGINT", () => {
    if (healthToken === undefined) {
      void stop();
      return;
    }
    logger.info({ tag: "mcp-http", op: "sigint_ignored" }, "Ctrl-C is left to the libi server that launched this endpoint");
  });

  // Only a supervised launch (the token is how a libi server marks one) treats
  // its stdin as a lifeline. The supervisor holds the only write end of that
  // pipe and never writes to it, so end-of-file means the libi server that
  // launched this process is gone, however it ended: a closed terminal or a
  // test runner's group SIGKILL never reaches this process, which has a
  // process group of its own. A run by hand is left alone: its stdin is a
  // terminal, or /dev/null under a service manager, and neither says anything
  // about whether it should keep serving. Watched before the server starts, so
  // a supervisor that dies during startup is noticed too.
  //
  // On Windows this is a backstop, not the usual path. A non-detached child
  // there (this process, spawned by the libi server) sits in a job object
  // that libuv/Node ties to its parent, so a killed server already takes this
  // process down through that job object before stdin ever sees end-of-file.
  // QA force-killed a libi server on Windows and watched its aggregator exit
  // within a few hundred milliseconds with no sign of noticing stdin close
  // first. Losing a supervisor some other way — one that lets the aggregator
  // outlive it long enough to notice, or a hand-run process whose parent
  // never held it in a job at all — is what this listener is still for there.
  if (healthToken !== undefined) {
    const supervisorGone = () => {
      if (stopping) return;
      logger.warn({ tag: "mcp-http", op: "supervisor_gone" }, "the libi server that launched this endpoint is gone; shutting down");
      void stop();
    };
    process.stdin.on("end", supervisorGone);
    process.stdin.on("close", supervisorGone);
    // A pipe whose other end vanished can also surface as a read error.
    process.stdin.on("error", supervisorGone);
    process.stdin.resume();
  }

  // A supervisor gone while this was starting has already exited the process,
  // with nothing to close yet.
  const handle = await startMcpHttpServer({ port, healthToken });
  close = () => handle.close();
}

main().catch((err) => {
  logger.fatal({ err, tag: "mcp-http", op: "boot_failed" }, "HTTP MCP aggregator failed to start");
  reportStartupFailure(err);
  setTimeout(() => process.exit(1), 100);
});
