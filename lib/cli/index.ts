#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { startStudio } from "./studio";
import { serveMcp } from "./serve-mcp";
import { serveTrackingMcp } from "./serve-mcp-tracking";
import { serveMcpHttp } from "./serve-mcp-http";
import { connectCommand } from "./connect-command";
import { packageRoot } from "@/lib/runtime/package-root";
import { installStdioResilience } from "./stdio-resilience";

/** The real published version. Never hardcode it: `libi --version` reported a
 *  stale "0.1.0" forever after any bump. `packageRoot` walks up from
 *  `__dirname`, so this resolves in dev (`lib/cli/`) and in the compiled
 *  `dist-cli/lib/cli/` mirror alike. */
function readOwnVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(packageRoot(__dirname), "package.json"), "utf-8"),
    );
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

// Tri-state on purpose: declaring `--open` FIRST means commander leaves
// `opts.open` undefined when neither flag is passed, so `shouldOpenBrowser`
// can tell "the user said nothing" from "the user said yes" and apply the
// installed-vs-dev-checkout default. Declaring only `--no-open` would silently
// default it to `true` and take that decision away.
const OPEN_DESC =
  "Open the studio in your default browser once it's ready (default: on for an installed libi, off in a dev checkout)";
const NO_OPEN_DESC = "Don't launch a browser — just print the URL";

/** Both the `studio` subcommand and the bare `npx libi` default action take
 *  the same options; keep them defined in one place so they can't drift. */
function studioOptions(cmd: Command): Command {
  return cmd
    .option("-p, --port <port>", "Port number", "3456")
    .option("--open", OPEN_DESC)
    .option("--no-open", NO_OPEN_DESC);
}

/**
 * The whole `libi` command tree, unparsed. Built by a function so a test can
 * parse argv against it with the actions stubbed; importing this module runs
 * nothing (see the entry-point guard at the bottom).
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("libi")
    .description("Libi AI Video Studio — CLI tools")
    .version(readOwnVersion())
    // The root program and `serve-mcp-http` both declare `-p, --port`. Without
    // positional options commander gives a flag to the ROOT wherever it
    // appears, so `libi serve-mcp-http --port 3458` (and `libi studio --port
    // 3470`) silently kept the default. Positional: flags before a subcommand
    // belong to the root, flags after it to that subcommand.
    .enablePositionalOptions();

  // libi studio
  studioOptions(program.command("studio").description("Start the Libi studio (web UI)")).action(
    async (opts) => {
      await startStudio(opts.port, { open: opts.open });
    },
  );

  // libi serve-mcp
  program
    .command("serve-mcp")
    .description("Start the MCP server on stdio (for agent integration)")
    .action(async () => {
      await serveMcp();
    });

  // libi serve-mcp-tracking
  program
    .command("serve-mcp-tracking")
    .description("Start the libi-tracking MCP server on stdio (for agent integration)")
    .action(async () => {
      await serveTrackingMcp();
    });

  // libi serve-mcp-http
  program
    .command("serve-mcp-http")
    .description("Serve libi's own MCP tools over HTTP on one local port")
    .option("-p, --port <port>", "Port (default: LIBI_MCP_PORT, else 3457)")
    .action(async (opts) => {
      await serveMcpHttp(opts.port);
    });

  // libi connect
  program
    .command("connect [dir]")
    .description(
      "Use libi from your own Claude Code or Codex: register libi's tools for your account and install libi's skills in that folder (default: the folder you ran this from). libi keeps them up to date.",
    )
    .option("--global", "Install libi's skills for every folder (~/.claude/skills and ~/.agents/skills) instead of one folder.")
    .action(async (dir: string | undefined, opts: { global?: boolean }) => {
      await connectCommand(dir, opts);
    });

  // libi export (placeholder)
  program
    .command("export")
    .description("Export a composition to MP4 (requires headless Chrome)")
    .option("--piece <id>", "Piece ID", "default")
    .option("--output <path>", "Output file path", "output.mp4")
    .action(async () => {
      console.log(
        "Export is not yet implemented. Use the Libi Studio UI to export."
      );
      console.log("Run: libi studio");
    });

  // Default action: running `npx libi` without a subcommand starts the studio
  studioOptions(program).action(async (opts) => {
    await startStudio(opts.port, { open: opts.open });
  });

  return program;
}

/** What `runCli` uses of the process; injectable so a test can drive `beforeExit`. */
export type CliProcess = Pick<NodeJS.EventEmitter, "on" | "off"> & {
  stderr: { write(chunk: string): unknown };
  exitCode?: number | string | null;
};

/** Written when the process is about to exit with the command still unfinished. */
export const STOPPED_MID_COMMAND = "[libi] ✗ libi stopped before the command finished.\n";

/**
 * Parse `argv` and run the matched command, reporting a rejection instead of
 * letting it disappear. `program.parse()` never awaits an async `.action()`
 * — a rejection escaping one (a bug in `connectCommand`, say) had no
 * attached handler at all (`lib/logger.ts`'s unhandledRejection listener
 * only logs) and the process exited 0 having silently done nothing.
 * `parseAsync` awaits the action; this awaits `parseAsync` in turn and
 * reports whatever escapes, with `process.exitCode` (not `process.exit()`,
 * which would cut off in-flight stdout/stderr writes) so a long-running
 * action — the default `studio` command — is unaffected either way.
 */
export async function runCli(argv: string[] = process.argv, proc: CliProcess = process): Promise<void> {
  // A command can also end WITHOUT rejecting: when the event loop runs out of
  // work while its promise is pending, Node exits 0 and the catch below never
  // runs. `libi connect` did exactly that (an unref'd lookup nothing held the
  // loop open for). `beforeExit` is emitted only when the loop is empty, so
  // while the action is unsettled it means the action can never finish: say so
  // and fail the run. The listener goes as soon as the action settles, and
  // every long-running action (the studio, the serve-* commands) settles once
  // it is serving — a server that later shuts down is never reported.
  let reported = false;
  const onBeforeExit = (): void => {
    if (reported) return; // emitted again each time the loop empties
    reported = true;
    proc.stderr.write(STOPPED_MID_COMMAND);
    proc.exitCode = 1;
  };
  proc.on("beforeExit", onBeforeExit);
  try {
    await buildProgram().parseAsync(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    proc.stderr.write(`[libi] ✗ ${message}\n`);
    proc.exitCode = 1;
  } finally {
    proc.off("beforeExit", onBeforeExit);
  }
}

// `bin/libi.js` runs this file as the entry point (compiled, or through tsx).
// Importing it — the CLI tests do — must neither parse argv nor touch stdio.
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  // Before anything can log: a dead stdout pipe must not be able to kill the
  // server. See ./stdio-resilience for the three incidents this prevents.
  installStdioResilience();
  void runCli();
}
