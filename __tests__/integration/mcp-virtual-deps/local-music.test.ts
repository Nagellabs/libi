/**
 * `getStatuses` only reads the registry and probes the isolated LIBI_HOME for
 * artifacts that are not there — it installs nothing, downloads nothing, and
 * needs no provisioned env. It sat behind `LIBI_TEST_INTEGRATION` alongside
 * the two music tests that genuinely do need a real uv environment, so it
 * never ran anywhere despite being hermetic and finishing in well under a
 * second. Gate removed: it runs like any other unit test.
 */
import { describe, it, expect } from "vitest";

describe("DependencyManager merges local-music virtual deps", () => {
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
