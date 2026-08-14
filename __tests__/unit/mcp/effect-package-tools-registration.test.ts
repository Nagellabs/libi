import { describe, it, expect } from "vitest";
import { registeredToolNames } from "@/__tests__/helpers/mcp-tools";
import { createLibiMcpServer } from "@/mcp/server";

const EFFECT_PACKAGE_TOOLS = [
  "libi.install_effect_from_git",
  "libi.add_effect",
  "libi.update_effect",
  "libi.remove_effect",
  "libi.list_effect_packages",
] as const;

describe("custom effect package tools registration", () => {
  it("registers all five effect-package management tools on the core libi MCP", () => {
    const server = createLibiMcpServer();
    const names = registeredToolNames(server);
    for (const id of EFFECT_PACKAGE_TOOLS) {
      expect(names).toContain(id);
    }
  });
});
