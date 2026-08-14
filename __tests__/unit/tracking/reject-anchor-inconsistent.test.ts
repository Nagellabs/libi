import { describe, it, expect } from "vitest";
import { rejectAnchorInconsistentBoxes } from "@/lib/tracking/reject-anchor-inconsistent";
import type { TrackSample } from "@/lib/tracking/types";

function smp(
  t: number,
  x: number,
  y: number,
  w = 100,
  h = 100,
  sim: number | null = null,
): TrackSample {
  return { t, x, y, w, h, confidence: 1, visible: true, targetSim: sim };
}

const range = { start: 20, end: 26 };
// User pinned Lisa: a head-ish box. Center ≈ (290, 331) at t=21, (428, 425) at t=23.
const anchors = [
  { time: 21, bbox: [225, 284, 130, 94] as [number, number, number, number] },
  { time: 23, bbox: [348, 355, 160, 140] as [number, number, number, number] },
];

describe("rejectAnchorInconsistentBoxes", () => {
  it("keeps a visible box that sits near the interpolated anchor trajectory", () => {
    // t=22 → midway expected center ≈ ((290+428)/2, (331+425)/2) = (359, 378).
    const s = smp(22, 320, 340, 130, 110); // center (385, 395) — within tolerance
    const out = rejectAnchorInconsistentBoxes({ samples: [s], anchors, range });
    expect(out[0].visible).toBe(true);
  });

  it("rejects a visible box far from the anchor trajectory (the cameraman), REGARDLESS of high targetSim", () => {
    // Contaminated-template case: appearance says match (0.93) but the box is
    // way off where the user pinned the subject.
    const cam = smp(24, 40, 120, 150, 320, 0.93); // center (115, 280), far from ~(428,425)
    const out = rejectAnchorInconsistentBoxes({ samples: [cam], anchors, range });
    expect(out[0].visible).toBe(false);
    expect(out[0].confidence).toBe(0);
  });

  it("returns samples unchanged when there are no anchors (no ground truth)", () => {
    const s = smp(24, 40, 120);
    const out = rejectAnchorInconsistentBoxes({ samples: [s], anchors: [], range });
    expect(out).toEqual([s]);
  });

  it("never touches samples outside the range or already not-visible", () => {
    const before = smp(10, 40, 120); // out of range
    const notVis: TrackSample = { ...smp(22, 40, 120), visible: false };
    const out = rejectAnchorInconsistentBoxes({
      samples: [before, notVis],
      anchors,
      range,
    });
    expect(out[0]).toEqual(before); // untouched (out of range, even though far)
    expect(out[1].visible).toBe(false); // unchanged
  });

  it("single anchor: carries its position; rejects a far box, keeps a near one", () => {
    const one = [
      { time: 23, bbox: [348, 355, 160, 140] as [number, number, number, number] },
    ];
    const near = smp(21, 360, 360, 160, 140); // center (440, 430) ≈ anchor center (428, 425)
    const far = smp(25, 30, 600, 120, 120); // center (90, 660) — far
    const out = rejectAnchorInconsistentBoxes({
      samples: [near, far],
      anchors: one,
      range,
    });
    expect(out.find((p) => p.t === 21)!.visible).toBe(true);
    expect(out.find((p) => p.t === 25)!.visible).toBe(false);
  });

  it("is pure — does not mutate inputs", () => {
    const cam = smp(24, 40, 120, 150, 320);
    const snapshot = JSON.stringify(cam);
    rejectAnchorInconsistentBoxes({ samples: [cam], anchors, range });
    expect(JSON.stringify(cam)).toBe(snapshot);
  });
});
