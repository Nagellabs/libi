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

  // The rows libi installs itself — no plan for an agent to follow, by
  // design (libi-export's chromium downloads inside the first canvas export).
  // An explicit list, not "any def whose deps all have a custom
  // installer": that shape would silently exempt a future agent-installed
  // row from needing a plan. Adding to this list is a deliberate act.
  // `youtube-download` joined it too: uv + yt-dlp are fetched by the
  // first `libi.download_video` call, never by an agent following a plan.
  const LIBI_INSTALLED_IDS = new Set(["libi-export", "youtube-download"]);

  it("every agent-installed entry points at a plan file path under mcp/bundled-mcps/plans/", () => {
    for (const def of BUNDLED_MCPS) {
      if (LIBI_INSTALLED_IDS.has(def.id)) {
        expect(def.installPlanPath).toBeUndefined();
        expect(def.dependencies.length).toBeGreaterThan(0);
        expect(def.dependencies.every((d) => d.manualInstall)).toBe(true);
        continue;
      }
      expect(def.installPlanPath).toMatch(/^mcp\/bundled-mcps\/plans\/[a-z0-9-]+\.md$/);
    }
  });

  it("no entry outside the allowlist is flagged manualInstall", () => {
    for (const def of BUNDLED_MCPS) {
      if (LIBI_INSTALLED_IDS.has(def.id)) continue;
      expect(def.dependencies.some((d) => d.manualInstall)).toBe(false);
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

  it("includes the libi core row and every libi-owned extension", () => {
    const ids = BUNDLED_MCP_SERVERS.map((d) => d.id);
    expect(ids).toContain("libi");
    expect(ids).toEqual(expect.arrayContaining(["libi-tracking", "whisper", "local-tts", "local-music"]));
  });
});
