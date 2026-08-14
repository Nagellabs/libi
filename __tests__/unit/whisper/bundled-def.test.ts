import { describe, it, expect } from "vitest";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

describe("whisper bundled def", () => {
  const def = BUNDLED_MCP_SERVERS.find((d) => d.id === "whisper");
  it("exists, is tier-2, noServer, has an install plan, no required env", () => {
    expect(def).toBeTruthy();
    expect(def!.installFlow).toBe("tier-2");
    expect(def!.noServer).toBe(true);
    expect(def!.command).toBe("");
    expect(def!.args).toEqual([]);
    expect(def!.installPlanPath).toBe("mcp/bundled-mcps/plans/whisper.md");
    expect(def!.requiredEnvVars ?? []).toEqual([]);
    expect(def!.requireApproval).toBe(false);
  });
});
