import { describe, it, expect } from "vitest";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

describe("noServer rows are never spawnable", () => {
  it("any noServer def has empty command/args (cannot be spawned)", () => {
    for (const def of BUNDLED_MCP_SERVERS) {
      if (def.noServer) {
        expect(def.command).toBe("");
        expect(def.args).toEqual([]);
      }
    }
  });
});
