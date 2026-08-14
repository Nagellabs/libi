#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { startStudio } from "./studio";
import { serveMcp } from "./serve-mcp";
import { serveTrackingMcp } from "./serve-mcp-tracking";
import { updateProject } from "./update";
import { packageRoot } from "@/lib/runtime/package-root";

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

const CONNECT_AGENT_FLAG = "--connect-agent [dir]";
const CONNECT_AGENT_DESC =
  "Bring-your-own-CLI mode: serve headless and sync agent config (instructions, MCP servers, skills) to the given directory (default: the directory you ran libi from)";

const program = new Command();

program
  .name("libi")
  .description("Libi AI Video Studio — CLI tools")
  .version(readOwnVersion());

// libi studio
program
  .command("studio")
  .description("Start the Libi studio (web UI)")
  .option("-p, --port <port>", "Port number", "3456")
  .option(CONNECT_AGENT_FLAG, CONNECT_AGENT_DESC)
  .action(async (opts) => {
    await startStudio(opts.port, opts.connectAgent);
  });

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
program
  .option("-p, --port <port>", "Port number", "3456")
  .option(CONNECT_AGENT_FLAG, CONNECT_AGENT_DESC)
  .action(async (opts) => {
    await startStudio(opts.port, opts.connectAgent);
  });

program.parse();
