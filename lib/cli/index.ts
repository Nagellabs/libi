#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { startStudio } from "./studio";
import { serveMcp } from "./serve-mcp";
import { serveTrackingMcp } from "./serve-mcp-tracking";
import { updateProject } from "./update";
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

// Before anything can log: a dead stdout pipe must not be able to kill the
// server. See ./stdio-resilience for the three incidents this prevents.
installStdioResilience();

const CONNECT_AGENT_FLAG = "--connect-agent [dir]";
const CONNECT_AGENT_DESC =
  "Bring-your-own-CLI mode: serve headless and sync agent config (instructions, MCP servers, skills) to the given directory (default: the directory you ran libi from)";

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
    .option(CONNECT_AGENT_FLAG, CONNECT_AGENT_DESC)
    .option("--open", OPEN_DESC)
    .option("--no-open", NO_OPEN_DESC);
}

const program = new Command();

program
  .name("libi")
  .description("Libi AI Video Studio — CLI tools")
  .version(readOwnVersion());

// libi studio
studioOptions(program.command("studio").description("Start the Libi studio (web UI)")).action(
  async (opts) => {
    await startStudio(opts.port, opts.connectAgent, { open: opts.open });
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

// libi update
program
  .command("update")
  .description(
    "Update Libi skill files and templates to the latest version"
  )
  .action(async () => {
    await updateProject();
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
  await startStudio(opts.port, opts.connectAgent, { open: opts.open });
});

program.parse();
