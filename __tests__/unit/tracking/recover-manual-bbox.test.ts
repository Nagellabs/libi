import { describe, it, expect } from "vitest";
import { recoverManualBbox } from "@/lib/tracking/manual-anchors";
import { applyFitAndScale, resolveTrackedRect } from "@/lib/engine/overlay-renderer";
import type { TrackFit } from "@/lib/tracking/types";

const frame = { width: 1920, height: 1080 };
const rect = { x: 0, y: 0, width: 200, height: 200 };

function artCenter(bbox: [number, number, number, number], fit: TrackFit, scale: number) {
  const s = { x: bbox[0], y: bbox[1], w: bbox[2], h: bbox[3] };
  const a = applyFitAndScale(s, rect, fit, scale, frame);
  return { cx: a.x + a.w / 2, cy: a.y + a.h / 2 };
}

describe("recoverManualBbox closed loop", () => {
  for (const fit of ["tight", "head", "rect"] as TrackFit[]) {
    it(`fit=${fit}: recovered bbox renders its art centered on the drop point`, () => {
      const sample = { x: 400, y: 300, w: 120, h: 260, confidence: 1, visible: true, t: 1 };
      const drop = { x: 900, y: 500 };
      const bbox = recoverManualBbox({
        sample, fit, scale: 1, rect, frame, dropCenter: drop,
      });
      const { cx, cy } = artCenter(bbox, fit, 1);
      expect(cx).toBeCloseTo(drop.x, 3);
      expect(cy).toBeCloseTo(drop.y, 3);
      expect(bbox[2]).toBe(sample.w); // size unchanged
      expect(bbox[3]).toBe(sample.h);
    });
  }

  it("lost-at-T: sizes from the provided fallback w/h, centers on drop", () => {
    const bbox = recoverManualBbox({
      sample: null, fit: "tight", scale: 1, rect, frame,
      dropCenter: { x: 100, y: 100 }, fallbackSize: { w: 50, h: 80 },
    });
    expect(bbox).toEqual([75, 60, 50, 80]);
  });

  it("scale≠1: recovered bbox art center equals drop point (fit=tight, scale=2)", () => {
    const sample = { x: 400, y: 300, w: 120, h: 260, confidence: 1, visible: true, t: 1 };
    const drop = { x: 900, y: 500 };
    const bbox = recoverManualBbox({
      sample, fit: "tight", scale: 2, rect, frame, dropCenter: drop,
    });
    const { cx, cy } = artCenter(bbox, "tight", 2);
    expect(cx).toBeCloseTo(drop.x, 3);
    expect(cy).toBeCloseTo(drop.y, 3);
    expect(bbox[2]).toBe(120); // size unchanged
    expect(bbox[3]).toBe(260);
  });

  it("face-sized head (non-personLike): recovered bbox art center equals drop point (fit=head)", () => {
    // h=130 ≤ w*1.3=156 and box is small (not big), so takes the face-sized branch
    const sample = { x: 400, y: 300, w: 120, h: 130, confidence: 1, visible: true, t: 1 };
    const drop = { x: 700, y: 400 };
    const bbox = recoverManualBbox({
      sample, fit: "head", scale: 1, rect, frame, dropCenter: drop,
    });
    const { cx, cy } = artCenter(bbox, "head", 1);
    expect(cx).toBeCloseTo(drop.x, 3);
    expect(cy).toBeCloseTo(drop.y, 3);
  });

  it("clampToFrame triggered: art center equals drop point despite shrink (fit=tight, large sample)", () => {
    // w=1600, h=900 exceeds 66% of 1920×1080 — clampToFrame fires
    const sample = { x: 100, y: 100, w: 1600, h: 900, confidence: 1, visible: true, t: 1 };
    const drop = { x: 960, y: 540 };
    const bbox = recoverManualBbox({
      sample, fit: "tight", scale: 1, rect, frame, dropCenter: drop,
    });
    const { cx, cy } = artCenter(bbox, "tight", 1);
    expect(cx).toBeCloseTo(drop.x, 3);
    expect(cy).toBeCloseTo(drop.y, 3);
    // recovered bbox keeps original sample dimensions (only art is clamped)
    expect(bbox[2]).toBe(1600);
    expect(bbox[3]).toBe(900);
  });
});

describe("recoverManualBbox with a follow offset", () => {
  const sample = { x: 100, y: 200, w: 50, h: 100 };
  const frame = { width: 1000, height: 1000 };
  const rect = { x: 0, y: 0, width: 1000, height: 1000 };
  const offset = { x: 0, y: -1 }; // art renders one box-height ABOVE the subject

  it("dropping the art where it already renders implies NO track change", () => {
    const art = resolveTrackedRect(sample, { rect, fit: "tight", scale: 1, offset }, frame);
    const dropCenter = { x: art.x + art.w / 2, y: art.y + art.h / 2 };
    const bbox = recoverManualBbox({
      sample, fit: "tight", scale: 1, rect, frame, dropCenter, offset,
    });
    expect(bbox[0]).toBeCloseTo(sample.x, 6);
    expect(bbox[1]).toBeCloseTo(sample.y, 6);
    expect(bbox[2]).toBe(sample.w);
    expect(bbox[3]).toBe(sample.h);
  });

  it("without offset the behavior is unchanged (regression pin)", () => {
    const art = resolveTrackedRect(sample, { rect, fit: "tight", scale: 1 }, frame);
    const dropCenter = { x: art.x + art.w / 2 + 30, y: art.y + art.h / 2 + 40 };
    const bbox = recoverManualBbox({ sample, fit: "tight", scale: 1, rect, frame, dropCenter });
    expect(bbox[0]).toBeCloseTo(sample.x + 30, 6);
    expect(bbox[1]).toBeCloseTo(sample.y + 40, 6);
  });
});
