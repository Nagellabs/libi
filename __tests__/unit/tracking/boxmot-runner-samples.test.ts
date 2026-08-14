// __tests__/unit/tracking/boxmot-runner-samples.test.ts
import { describe, it, expect } from "vitest";
import { normalizeSamples } from "@/lib/tracking/boxmot-runner";

describe("normalizeSamples — targetSim coercion", () => {
  it("coerces a numeric targetSim and defaults missing/null to null", () => {
    const raw = [
      { t: 0, x: 1, y: 2, w: 3, h: 4, confidence: 0.9, visible: true, targetSim: "0.7" },
      { t: 0.1, x: 1, y: 2, w: 3, h: 4, confidence: 0, visible: false },
      { t: 0.2, x: 1, y: 2, w: 3, h: 4, confidence: 0.9, visible: true, targetSim: null },
    ];
    const out = normalizeSamples(raw);
    expect(out[0].targetSim).toBe(0.7);
    expect(out[1].targetSim).toBeNull();
    expect(out[2].targetSim).toBeNull();
  });

  it("returns [] for non-array input", () => {
    expect(normalizeSamples(undefined)).toEqual([]);
    expect(normalizeSamples(null)).toEqual([]);
  });
});
