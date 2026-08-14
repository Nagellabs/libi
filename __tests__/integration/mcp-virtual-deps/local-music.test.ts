import { describe, it, expect } from "vitest";

const RUN = process.env.LIBI_TEST_INTEGRATION === "1";

(RUN ? describe : describe.skip)("DependencyManager merges local-music virtual deps", () => {
  it("returns all three local-music virtual deps via getStatuses", async () => {
    const { DependencyManager } = await import("@/mcp/registry/dependency-manager");
    const mgr = new DependencyManager();
    const statuses = await mgr.getStatuses("local-music");
    const labels = statuses.map((s) => s.binary);
    expect(labels.some((l) => l.includes("ace-step weights"))).toBe(true);
    expect(labels.some((l) => l.includes("ace-step env"))).toBe(true);
    expect(labels.some((l) => l.includes("librosa env"))).toBe(true);
  });
});
