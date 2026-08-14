import { describe, it, expect } from "vitest";
import { STATIC_BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

describe("local-music bundled def", () => {
  it("is a noServer tier-2 row with uv as its only binary dep", () => {
    const def = STATIC_BUNDLED_MCP_SERVERS.find((d) => d.id === "local-music");
    expect(def).toBeDefined();
    expect(def!.noServer).toBe(true);
    expect(def!.installFlow).toBe("tier-2");
    expect(def!.requireApproval).toBe(false);
    expect(def!.requiredEnvVars).toEqual([]);
    expect(def!.installPlanPath).toBe("mcp/bundled-mcps/plans/local-music.md");
    // ACE-Step weights now ship as a virtual dep (`ace-step-model`);
    // legacy BundledDependency row was removed in QA-FIX-A.
    expect(def!.dependencies.map((d) => d.binary)).toEqual(["uv"]);
  });
});
