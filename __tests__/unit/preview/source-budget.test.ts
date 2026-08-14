import { describe, it, expect } from "vitest";
import { planSourceBudget, type BudgetClip } from "@/lib/preview/source-budget";

const clips: BudgetClip[] = [
  { id: "A", startSec: 0, endSec: 4 },
  { id: "B", startSec: 4, endSec: 8 },
  { id: "C", startSec: 8, endSec: 12 },
  { id: "D", startSec: 12, endSec: 16 },
];

describe("planSourceBudget", () => {
  it("marks the clip under the playhead active", () => {
    const p = planSourceBudget({ playheadSec: 1, clips, k: 3, warmAheadSec: 1 });
    expect(p.get("A")).toBe("active");
  });
  it("warms the next clip when within the warm-ahead window", () => {
    const p = planSourceBudget({ playheadSec: 3.5, clips, k: 3, warmAheadSec: 1 });
    expect(p.get("A")).toBe("active");
    expect(p.get("B")).toBe("warm");
    expect(p.get("C")).toBe("cold");
  });
  it("keeps far clips cold", () => {
    const p = planSourceBudget({ playheadSec: 1, clips, k: 3, warmAheadSec: 1 });
    expect(p.get("C")).toBe("cold");
    expect(p.get("D")).toBe("cold");
  });
  it("keeps ALL active sources live even beyond K (decode-all-active)", () => {
    const overlap: BudgetClip[] = [
      { id: "a", startSec: 0, endSec: 10 },
      { id: "b", startSec: 0, endSec: 10 },
      { id: "c", startSec: 0, endSec: 10 },
      { id: "d", startSec: 0, endSec: 10 },
      { id: "e", startSec: 0, endSec: 10 },
    ];
    // K is intentionally LOWER than the active count — active is never capped.
    const p = planSourceBudget({ playheadSec: 5, clips: overlap, k: 3, warmAheadSec: 1 });
    for (const id of ["a", "b", "c", "d", "e"]) expect(p.get(id)).toBe("active");
  });

  it("still caps WARM (upcoming) sources at K minus the active count", () => {
    const mixed: BudgetClip[] = [
      { id: "act", startSec: 0, endSec: 20 },
      { id: "w1", startSec: 10.5, endSec: 20 },
      { id: "w2", startSec: 10.6, endSec: 20 },
      { id: "w3", startSec: 10.7, endSec: 20 },
      { id: "w4", startSec: 10.8, endSec: 20 },
    ];
    const p = planSourceBudget({ playheadSec: 10, clips: mixed, k: 3, warmAheadSec: 2 });
    expect(p.get("act")).toBe("active");
    const warm = ["w1", "w2", "w3", "w4"].filter((id) => p.get(id) === "warm");
    expect(warm.length).toBe(2); // k(3) - active(1) = 2 warm slots; nearest two win
    expect(p.get("w1")).toBe("warm");
    expect(p.get("w2")).toBe("warm");
    expect(p.get("w3")).toBe("cold");
    expect(p.get("w4")).toBe("cold");
  });

  it("never gives warm a negative slot count when active already exceeds K", () => {
    const overlap: BudgetClip[] = [
      { id: "a", startSec: 0, endSec: 10 },
      { id: "b", startSec: 0, endSec: 10 },
      { id: "c", startSec: 0, endSec: 10 },
      { id: "w", startSec: 10.2, endSec: 20 },
    ];
    const p = planSourceBudget({ playheadSec: 5, clips: overlap, k: 2, warmAheadSec: 2 });
    expect(p.get("a")).toBe("active");
    expect(p.get("b")).toBe("active");
    expect(p.get("c")).toBe("active");
    expect(p.get("w")).toBe("cold"); // 0 warm slots, but w isn't active at t=5 anyway
  });
});
