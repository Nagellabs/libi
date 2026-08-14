import { describe, it, expect } from "vitest";
import { STATIC_BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

describe("local-tts bundled def", () => {
  it("exists, is a noServer tier-2 row with no required env", () => {
    const def = STATIC_BUNDLED_MCP_SERVERS.find((d) => d.id === "local-tts");
    expect(def).toBeDefined();
    expect(def!.noServer).toBe(true);
    expect(def!.installFlow).toBe("tier-2");
    expect(def!.requireApproval).toBe(false);
    expect(def!.requiredEnvVars).toEqual([]);
    expect(def!.installPlanPath).toBe("mcp/bundled-mcps/plans/local-tts.md");
    // Kokoro weights now ship as a virtual dep (`tts-model`); legacy
    // BundledDependency row was removed in QA-FIX-A.
    expect(def!.dependencies?.map((d) => d.binary)).toEqual(["uv"]);
  });
});
