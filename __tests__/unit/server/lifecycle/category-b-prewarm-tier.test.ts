import { describe, expect, it, vi } from "vitest";

/**
 * Regression for the every-boot `npx -y @kevinwatt/yt-dlp-mcp@0.9.0`.
 *
 * `defaultCategoryBDeps.probeAndPersist` called `prewarmBundledMcps()` with no
 * argument, which defaults to `tier: "all"` — so every tier-2 MCP whose deps
 * happened to settle "installed" got spawned at boot. youtube-downloader always
 * did, because its uv + yt-dlp deps were tier-1-flagged and Category A
 * installed them. Warm that is 1.5-2 s; cold it is minutes; offline it fails.
 */
describe("Category B pre-warm tier", () => {
  it("pre-warms tier-1 only", async () => {
    const prewarmBundledMcps = vi.fn(async () => {});
    const settleAllBundledStatuses = vi.fn(async () => {});
    vi.doMock("@/mcp/registry/dependency-manager", () => ({
      DependencyManager: class {
        settleAllBundledStatuses = settleAllBundledStatuses;
        prewarmBundledMcps = prewarmBundledMcps;
      },
    }));
    const { defaultCategoryBDeps } = await import("@/lib/server/lifecycle/category-b");
    await defaultCategoryBDeps.probeAndPersist();
    expect(prewarmBundledMcps).toHaveBeenCalledWith({ tier: "tier-1" });
  });
});
