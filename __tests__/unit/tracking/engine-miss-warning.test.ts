import { describe, it, expect } from "vitest";
import { engineMissWarning } from "@/mcp/tools/tracking-tools";
import type { TrackSummary } from "@/lib/tracking/summary";

const base: TrackSummary = {
  total: 0, visible: 0, visibleRanges: [], lostRanges: [], flags: [], issues: [], perSegment: [],
};

describe("engineMissWarning", () => {
  it("returns the engine-miss instruction when total is 0", () => {
    const w = engineMissWarning({ ...base, total: 0 });
    expect(w).toContain("ENGINE PRODUCED NO TRACK");
    expect(w).toContain("ground_target");
    expect(w).toContain("method:'sot'");
  });

  it("returns the engine-miss instruction when flags include no_output even if total>0", () => {
    const w = engineMissWarning({ ...base, total: 43, flags: ["no_output"] });
    expect(w).toContain("ENGINE PRODUCED NO TRACK");
  });

  it("returns the generic quality-issues instruction when issues exist and it's not a miss", () => {
    const w = engineMissWarning({
      ...base, total: 100, visible: 90,
      flags: ["identity_switch_suspected"],
      issues: [{ kind: "identity_switch_suspected", range: { start: 1, end: 2 }, detail: "x" }],
    });
    expect(w).toContain("TRACK QUALITY ISSUES DETECTED");
  });

  it("returns undefined for a clean track", () => {
    expect(engineMissWarning({ ...base, total: 100, visible: 100 })).toBeUndefined();
  });
});
