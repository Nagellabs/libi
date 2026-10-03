import { describe, it, expect } from "vitest";
import { registeredToolNames } from "@/__tests__/helpers/mcp-tools";
import { createLibiMcpServer } from "@/mcp/server";
import { registeredMergedTools } from "@/mcp/tools/action-registry";

// install_effect_from_git is an action here (not a separate tool): it is not approval-gated, not an
// extension install and not a job, so it falls under the same ungated tool as the rest.
const EFFECT_ACTIONS = ["list", "list_packages", "add", "update", "remove", "install_from_git"] as const;

describe("custom effect package tools registration", () => {
  it("registers the merged libi.effect tool with every effect-package action on the core libi MCP", () => {
    const server = createLibiMcpServer();
    expect(registeredToolNames(server)).toContain("libi.effect");
    expect([...registeredMergedTools().get("libi.effect")!.actions]).toEqual([...EFFECT_ACTIONS]);
  });

  it("registers none of the per-verb effect tools", () => {
    const names = registeredToolNames(createLibiMcpServer());
    for (const old of ["install_effect_from_git", "add_effect", "update_effect", "remove_effect", "list_effect_packages", "list_effects"]) {
      expect(names).not.toContain(`libi.${old}`);
    }
  });
});
