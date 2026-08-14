import { describe, it, expect } from "vitest";
import { selectVerifyTimes } from "@/lib/tracking/verify-grid";

describe("selectVerifyTimes", () => {
  it("densely samples issue + lost ranges and the final seconds, excludes anchor times", () => {
    const r = selectVerifyTimes({
      clipDurationSec: 30,
      fps: 30,
      manualAnchorTimes: [10],
      issueRanges: [{ start: 4, end: 7 }],
      lostRanges: [{ start: 20, end: 22 }],
      focusRange: null,
      extraTimes: [],
      cap: 24,
    });
    for (const t of [4, 5, 6, 7]) expect(r.times).toContain(t);
    for (const t of [20, 21, 22]) expect(r.times).toContain(t);
    expect(r.times.some((t) => t >= 25)).toBe(true);
    expect(r.times.every((t) => Math.abs(t - 10) > 0.2)).toBe(true);
    expect(r.times).toEqual([...r.times].sort((a, b) => a - b));
    expect(r.coveredIssueRanges).toEqual([{ start: 4, end: 7 }]);
  });

  it("honors focusRange + extraTimes and reports truncation when over cap", () => {
    const r = selectVerifyTimes({
      clipDurationSec: 600,
      fps: 30,
      manualAnchorTimes: [],
      issueRanges: [],
      lostRanges: [],
      focusRange: { start: 100, end: 104 },
      extraTimes: [3.5],
      cap: 6,
    });
    expect(r.times).toContain(3.5);
    expect(r.times).toContain(100);
    expect(r.times.length).toBeLessThanOrEqual(6);
    expect(r.truncated).toBe(true);
  });
});
