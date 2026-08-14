import { describe, it, expect } from "vitest";
import { BUNDLED_MCPS } from "@/mcp/bundled-mcps/registry";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

describe("bundled-mcps registry", () => {
  it("exposes a non-empty list of tier-2 MCPs", () => {
    expect(Array.isArray(BUNDLED_MCPS)).toBe(true);
    expect(BUNDLED_MCPS.length).toBeGreaterThan(0);
  });

  it("every entry declares installFlow=tier-2", () => {
    for (const def of BUNDLED_MCPS) {
      expect(def.installFlow).toBe("tier-2");
    }
  });

  it("every entry points at a plan file path under mcp/bundled-mcps/plans/", () => {
    for (const def of BUNDLED_MCPS) {
      expect(def.installPlanPath).toMatch(/^mcp\/bundled-mcps\/plans\/[a-z0-9-]+\.md$/);
    }
  });

  it("each id is unique", () => {
    const ids = BUNDLED_MCPS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("bundled-mcps × registry parity", () => {
  it("every tier-2 entry in BUNDLED_MCP_SERVERS is also in BUNDLED_MCPS", () => {
    const tier2InCombined = BUNDLED_MCP_SERVERS
      .filter((d) => d.installFlow === "tier-2")
      .map((d) => d.id)
      .sort();
    const inTier2Registry = BUNDLED_MCPS.map((d) => d.id).sort();
    expect(inTier2Registry).toEqual(tier2InCombined);
  });

  it("includes youtube-downloader, elevenlabs, fal-ai", () => {
    const ids = BUNDLED_MCPS.map((d) => d.id);
    expect(ids).toContain("youtube-downloader");
    expect(ids).toContain("elevenlabs");
    expect(ids).toContain("fal-ai");
  });
});
