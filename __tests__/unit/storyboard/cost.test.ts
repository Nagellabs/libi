import { describe, it, expect } from "vitest";
import { storyboardCostSummary } from "@/lib/storyboard/cost";
import type { Storyboard } from "@/lib/storyboard/types";

const sb: Storyboard = {
  version: 2, cardOrder: ["a", "b"], budgetUsd: 10, updatedAt: "t",
  cards: [
    { id: "a", order: 0, durationSec: 6, role: "hook", kind: "canvas", title: "A",
      sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "sketches/sk_1/unit.jsx" } }],
      camera: { shot: "medium" },
      promptFragment: "x", stage: "clip", approvals: {},
      cost: { keyframeUsd: 0.04, clipUsd: 0.18 } },
    { id: "b", order: 1, durationSec: 6, role: "demo", kind: "canvas", title: "B",
      sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "sketches/sk_1/unit.jsx" } }],
      camera: { shot: "medium" },
      promptFragment: "x", stage: "keyframe", approvals: {},
      cost: { keyframeUsd: 0.04 } },
  ],
};

describe("storyboardCostSummary", () => {
  it("sums per-tier + total against budget", () => {
    const s = storyboardCostSummary(sb);
    expect(s.keyframeUsd).toBeCloseTo(0.08);
    expect(s.clipUsd).toBeCloseTo(0.18);
    expect(s.totalUsd).toBeCloseTo(0.26);
    expect(s.budgetUsd).toBe(10);
    expect(s.remainingUsd).toBeCloseTo(9.74);
  });
  it("handles no budget + no costs", () => {
    const s = storyboardCostSummary({ ...sb, budgetUsd: undefined, cards: [] });
    expect(s.totalUsd).toBe(0);
    expect(s.budgetUsd).toBeUndefined();
    expect(s.remainingUsd).toBeUndefined();
  });
});
