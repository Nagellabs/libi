/**
 * Every merged tool declares, as data, which of its actions only read and which change something
 * (`MERGED_TOOL_RISK`, lib/agents/merged-tools.ts) — the chat's "don't ask again" option is
 * withheld for a tool that has any changing action. This holds the table to the actions a real
 * server registers, so a new action cannot ship without being classified.
 */
import { describe, it, expect } from "vitest";
import { createLibiMcpServer } from "@/mcp/server";
import { extensionForToolName } from "@/mcp/registry/bundled";
import { registeredMergedTools } from "@/mcp/tools/action-registry";
import { MERGED_TOOL_DISCRIMINATORS, MERGED_TOOL_RISK, mergedToolAllowsAlways } from "@/lib/agents/merged-tools";

describe("MERGED_TOOL_RISK", () => {
  it("covers exactly the merged tools, and classifies every declared action once", () => {
    // both surfaces: an action only one of them advertises is still registered in the registry
    createLibiMcpServer({ surface: "in-app" });
    createLibiMcpServer({ surface: "cli" });
    expect(registeredMergedTools().size, "the servers registered the merged tools").toBe(Object.keys(MERGED_TOOL_DISCRIMINATORS).length);
    expect(Object.keys(MERGED_TOOL_RISK).sort()).toEqual(Object.keys(MERGED_TOOL_DISCRIMINATORS).sort());
    for (const [name, info] of registeredMergedTools()) {
      const risk = MERGED_TOOL_RISK[name as keyof typeof MERGED_TOOL_RISK];
      expect(risk, `${name} declares its risk`).toBeDefined();
      const declared = [...risk.readOnly, ...risk.changes];
      expect(new Set(declared).size, `${name}: an action is listed twice`).toBe(declared.length);
      expect([...declared].sort(), `${name}: readOnly + changes must be exactly its actions`).toEqual([...info.actions].sort());
    }
  });

  it("allows 'always' only for tools whose every action reads", () => {
    const allowing = Object.keys(MERGED_TOOL_RISK).filter((n) => mergedToolAllowsAlways(n)).sort();
    expect(allowing).toEqual(["libi.analysis_query", "libi.audio_analyze", "libi.show"]);
    // mixed and changing-only tools are withheld, including both tracking tools
    for (const n of ["libi.snapshot", "libi.track", "libi.tracked_overlay", "libi.piece_folder", "libi.clip"]) {
      expect(mergedToolAllowsAlways(n), n).toBe(false);
    }
  });

  it("leaves a tool that is not merged alone", () => {
    expect(mergedToolAllowsAlways("libi.list_pieces")).toBe(true);
    expect(mergedToolAllowsAlways("libi.delete_piece")).toBe(true);
  });

  it("the extension approval gate and the remembered 'always' are both keyed on the tool name: only the two tracking tools belong to an extension", () => {
    // A merged tool mixing an extension-gated verb with ungated ones would gate (or fail to gate) every
    // action alike, and nothing in registerActionTool can tell. So pin who owns what.
    const owned = Object.keys(MERGED_TOOL_RISK).filter((n) => extensionForToolName(n) !== null).sort();
    expect(owned).toEqual(["libi.track", "libi.tracked_overlay"]);
    for (const n of owned) expect(extensionForToolName(n)?.id).toBe("libi-tracking");
  });
});
