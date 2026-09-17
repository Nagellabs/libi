import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * libi stopped managing third-party MCP servers on this branch: the user
 * owns their agent's MCP config, and the only servers libi still installs are
 * its OWN free on-device extensions (`local-tts`, `local-music`, `whisper`,
 * `youtube-download`, `libi-tracking`, `libi-export`).
 *
 * The agent manual was rewritten for that model; six tool descriptions were
 * not, and still said "a bundled MCP". Descriptions are read at tool-SELECTION
 * time — before the manual is consulted for anything — so they teach the
 * removed model at the worst possible moment. The follow-up named four; the
 * same string was in `update_dep_status` and `test_mcp_server` too.
 *
 * This is a text scan rather than a `createLibiMcpServer()` walk on purpose:
 * building the server pulls in the DB, the job client and every tool module,
 * and the thing under test is a string literal in one file.
 */

const SERVER_TS = path.resolve(__dirname, "../../../mcp/server.ts");

/** Every `description:` value in `mcp/server.ts`, as raw source text. Each
 *  registration is `description:` … up to the `inputSchema:` that follows it. */
function toolDescriptions(source: string): string[] {
  const out: string[] = [];
  const re = /\n\s*description:\s*([\s\S]*?)\n\s*inputSchema:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]!);
  return out;
}

/** Phrases that each encode the MCP model this branch removed. */
const REMOVED_PHRASES: readonly [string, string][] = [
  ["bundled MCP", "libi bundles no third-party MCP server — say 'libi extension'"],
  ["bundled MCPs", "libi bundles no third-party MCP server — say 'libi extension'"],
];

describe("MCP tool descriptions — the provider model, not the bundled-MCP one", () => {
  const source = fs.readFileSync(SERVER_TS, "utf-8");
  const descriptions = toolDescriptions(source);

  it("finds the descriptions to check at all", () => {
    // Guards the regex itself: a parser that silently matches nothing would
    // make every assertion below vacuously true.
    expect(descriptions.length).toBeGreaterThan(50);
  });

  it("no tool description still describes libi as bundling MCP servers", () => {
    for (const [phrase, why] of REMOVED_PHRASES) {
      const offenders = descriptions.filter((d) => d.includes(phrase));
      expect(offenders, `${offenders.length} description(s) say "${phrase}" — ${why}`).toEqual([]);
    }
  });
});
