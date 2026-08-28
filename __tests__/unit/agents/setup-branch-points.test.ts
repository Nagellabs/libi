import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Strip comments so a rule about CODE is not satisfied or broken by prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("agent setup is declared, not branched on", () => {
  it("detection dispatches through the table, not an id comparison", () => {
    const src = stripComments(read("lib/agents/acp/agent-registry.ts"));
    // The exact shape that made a third agent silently become Codex.
    expect(src).not.toMatch(/if\s*\(\s*agent\.id\s*===\s*["']claude-code["']\s*\)/);
  });

  it("the sign-in remedy is looked up, not forked", () => {
    const src = stripComments(read("lib/sessions/session-manager.ts"));
    expect(src).not.toMatch(/agentId\s*===\s*["']codex["']/);
    expect(src).not.toMatch(/agentId\s*===\s*["']claude-code["']/);
  });

  it("agent display names come from one place", () => {
    const src = stripComments(read("lib/sessions/prompt-error-note.ts"));
    expect(src).not.toContain('"Claude Code"');
    expect(src).not.toContain('"Codex"');
    expect(src).toContain("getAgentSetup");
  });

  it("still knows the branch points that deliberately stay", () => {
    // These encode real per-agent CAPABILITY, not setup copy, and forcing them
    // into the registry would model differences that are genuinely different.
    // If one of these ever disappears, this test should be revisited, not
    // silently deleted.
    expect(stripComments(read("lib/sessions/session-meta.ts"))).toMatch(/claude-code/);
    expect(stripComments(read("lib/mcp-config.ts"))).toMatch(/ACP_HTTP_CAPABLE/);
  });
});
