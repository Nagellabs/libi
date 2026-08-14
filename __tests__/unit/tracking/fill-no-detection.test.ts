import { describe, it, expect } from "vitest";
import { fillNoDetectionFromAnchors } from "@/lib/tracking/fill-no-detection";
import type { TrackSample } from "@/lib/tracking/types";

function smp(t: number, vis: boolean, x = 0): TrackSample {
  return { t, x, y: 0, w: vis ? 10 : 0, h: vis ? 10 : 0,
    confidence: vis ? 1 : 0, visible: vis };
}

describe("fillNoDetectionFromAnchors", () => {
  it("fills a no-detection run that WAS visible before, interpolating from anchors", () => {
    const newSamples = [
      smp(0, true, 0), smp(1, false), smp(2, false), smp(3, true, 30),
    ];
    const priorSamples = [
      smp(0, true), smp(1, true), smp(2, true), smp(3, true),
    ];
    const out = fillNoDetectionFromAnchors({
      newSamples, priorSamples,
      anchors: [{ time: 1, bbox: [10, 0, 10, 10] }],
      range: { start: 0, end: 3 },
    });
    const at1 = out.find((s) => s.t === 1)!;
    const at2 = out.find((s) => s.t === 2)!;
    expect(at1.visible).toBe(true);
    expect(at1.x).toBe(10);            // anchor box at t=1
    expect(at1.confidence).toBe(0);    // honest: held, not detected
    expect(at1.targetSim ?? null).toBeNull();
    expect(at2.visible).toBe(true);    // interpolated between anchor(t1) and visible newSample(t3)
    expect(at2.x).toBe(20);            // exact midpoint: lerp(10, 30, 0.5) = 20
  });

  it("leaves a no-detection run alone when it was NOT visible before (honest gap)", () => {
    const newSamples = [smp(0, true), smp(1, false), smp(2, true)];
    const priorSamples = [smp(0, true), smp(1, false), smp(2, true)];
    const out = fillNoDetectionFromAnchors({
      newSamples, priorSamples, anchors: [], range: { start: 0, end: 2 },
    });
    expect(out.find((s) => s.t === 1)!.visible).toBe(false);
  });

  it("never yields fewer visible samples than the prior coverage in the range", () => {
    const newSamples = [smp(0, false), smp(1, false), smp(2, false)];
    const priorSamples = [smp(0, true), smp(1, true), smp(2, true)];
    const out = fillNoDetectionFromAnchors({
      newSamples, priorSamples,
      anchors: [{ time: 1, bbox: [5, 5, 8, 8] }],
      range: { start: 0, end: 2 },
    });
    expect(out.filter((s) => s.visible).length).toBeGreaterThanOrEqual(3);
  });

  it("regression: two DISTINCT known entries at the SAME t produce finite (no NaN) box", () => {
    // Two anchors both at time=1 with different bboxes — coincident-t divide-by-zero guard.
    const newSamples = [smp(1, false)];
    const priorSamples = [smp(1, true)];
    const out = fillNoDetectionFromAnchors({
      newSamples, priorSamples,
      anchors: [
        { time: 1, bbox: [10, 10, 20, 20] },
        { time: 1, bbox: [50, 50, 20, 20] },  // second anchor at same t
      ],
      range: { start: 0, end: 2 },
    });
    const at1 = out.find((s) => s.t === 1)!;
    expect(at1.visible).toBe(true);
    expect(Number.isFinite(at1.x)).toBe(true);
    expect(Number.isFinite(at1.y)).toBe(true);
    expect(Number.isFinite(at1.w)).toBe(true);
    expect(Number.isFinite(at1.h)).toBe(true);
  });

  it("prior NOT visible at hole BUT in-range anchor present → hole IS filled from anchor", () => {
    // This is the Fix 1 regression case: rejectWrongSubjectRuns may blank a run
    // that was actually the correct subject (legit appearance dip — profile turn /
    // motion blur). After blanking, priorVisibleAt is also false (prior had a gap
    // there too). Without the `anchored` guard the fill would leave it as an honest
    // gap — but there is an explicit user/agent anchor inside the window asserting
    // the subject IS here, so we MUST fill from the anchor box.
    const newSamples = [smp(0, true, 50), smp(1, false), smp(2, false), smp(3, true, 50)];
    // prior track also has a gap at t=1,2 (no prior coverage)
    const priorSamples = [smp(0, true, 50), smp(1, false), smp(2, false), smp(3, true, 50)];
    const out = fillNoDetectionFromAnchors({
      newSamples,
      priorSamples,
      anchors: [{ time: 1, bbox: [77, 0, 10, 10] as [number, number, number, number] }],
      range: { start: 0, end: 3 },
    });
    const at1 = out.find((s) => s.t === 1)!;
    const at2 = out.find((s) => s.t === 2)!;
    // The anchor asserts the subject IS at t=1 — hole must be filled
    expect(at1.visible).toBe(true);
    expect(at1.x).toBe(77);          // anchor box x
    expect(at1.confidence).toBe(0);  // honest: held, not detected
    expect(at1.targetSim ?? null).toBeNull();
    // t=2 is also filled (interpolated between anchor at t=1 and visible sample at t=3)
    expect(at2.visible).toBe(true);
    expect(at2.confidence).toBe(0);
  });

  it("single-sided carry: no-detection hole before first known carries hi; after last known carries lo", () => {
    // anchor at t=2 only
    const anchor = { time: 2, bbox: [100, 100, 20, 20] as [number, number, number, number] };
    const newSamples = [smp(0, false), smp(2, false), smp(4, false)];
    const priorSamples = [smp(0, true), smp(2, true), smp(4, true)];
    const out = fillNoDetectionFromAnchors({
      newSamples, priorSamples,
      anchors: [anchor],
      range: { start: 0, end: 4 },
    });
    const at0 = out.find((s) => s.t === 0)!;
    const at4 = out.find((s) => s.t === 4)!;
    // before first known (t=0 < t=2) ⇒ carry hi = anchor box
    expect(at0.visible).toBe(true);
    expect(Number.isFinite(at0.x)).toBe(true);
    expect(at0.x).toBe(100);
    // after last known (t=4 > t=2) ⇒ carry lo = anchor box
    expect(at4.visible).toBe(true);
    expect(Number.isFinite(at4.x)).toBe(true);
    expect(at4.x).toBe(100);
  });
});
