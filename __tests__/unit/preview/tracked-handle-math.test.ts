import { describe, it, expect } from "vitest";
import {
  trackedScaleFromDrag,
  spinTransformAt,
  trackedSizePctFromScale,
  trackedScaleFromSizePct,
  trackedSizeFloorScale,
  TRACKED_SCALE_MIN,
  TRACKED_SCALE_MAX,
} from "@/lib/preview/tracked-handle-math";

const art = { x: 100, y: 200, w: 80, h: 120 }; // center (140, 260)

describe("trackedScaleFromDrag", () => {
  it("doubles the center distance ⇒ doubles the scale (rotation-invariant ratio)", () => {
    // down at the SE corner (dist 72.11 from center), cur at 2× that vector.
    const down = { x: 180, y: 320 };
    const cur = { x: 220, y: 380 };
    expect(trackedScaleFromDrag({ art, startScale: 1.2, down, cur })).toBeCloseTo(2.4, 6);
  });

  it("no movement ⇒ startScale unchanged", () => {
    const p = { x: 180, y: 320 };
    expect(trackedScaleFromDrag({ art, startScale: 0.7, down: p, cur: p })).toBeCloseTo(0.7, 6);
  });

  it("clamps to the persistence bound [0.05, 5]", () => {
    const down = { x: 180, y: 320 };
    expect(
      trackedScaleFromDrag({ art, startScale: 4, down, cur: { x: 340, y: 560 } }),
    ).toBe(TRACKED_SCALE_MAX);
    expect(
      trackedScaleFromDrag({ art, startScale: 0.1, down, cur: { x: 141, y: 261 } }),
    ).toBe(TRACKED_SCALE_MIN);
  });

  it("degenerate anchor (pointer-down AT the center) ⇒ startScale, never NaN/Infinity", () => {
    const center = { x: 140, y: 260 };
    expect(
      trackedScaleFromDrag({ art, startScale: 1.5, down: center, cur: { x: 300, y: 300 } }),
    ).toBe(1.5);
  });
});

describe("tracked inspector Size ↔ scale mapping", () => {
  it("displays the scale multiplier as a rounded percent", () => {
    expect(trackedSizePctFromScale(1)).toBe(100);
    expect(trackedSizePctFromScale(2.5)).toBe(250);
    expect(trackedSizePctFromScale(0.333)).toBe(33);
  });

  it("commits percent back as a scale multiplier", () => {
    expect(trackedScaleFromSizePct(100)).toBeCloseTo(1, 9);
    expect(trackedScaleFromSizePct(250)).toBeCloseTo(2.5, 9);
  });

  it("clamps to the SAME persistence bounds as the gizmo drag ([0.05, 5])", () => {
    expect(trackedScaleFromSizePct(0)).toBe(TRACKED_SCALE_MIN);
    expect(trackedScaleFromSizePct(-40)).toBe(TRACKED_SCALE_MIN);
    expect(trackedScaleFromSizePct(1000)).toBe(TRACKED_SCALE_MAX);
  });

  it("round-trips an in-bounds value", () => {
    expect(trackedScaleFromSizePct(trackedSizePctFromScale(1.75))).toBeCloseTo(1.75, 9);
  });
});

describe("sub-floor legacy/agent-set scale — graceful slider floor", () => {
  it("trackedSizeFloorScale keeps the standard floor for normal scales", () => {
    expect(trackedSizeFloorScale(1)).toBe(0.05);
    expect(trackedSizeFloorScale(0.05)).toBe(0.05);
  });

  it("trackedSizeFloorScale lowers to a sub-floor current value", () => {
    expect(trackedSizeFloorScale(0.02)).toBe(0.02);
  });

  it("trackedSizeFloorScale is defensive about degenerate scales", () => {
    expect(trackedSizeFloorScale(0)).toBe(0.05);
    expect(trackedSizeFloorScale(-1)).toBe(0.05);
    expect(trackedSizeFloorScale(Number.NaN)).toBe(0.05);
  });

  it("trackedScaleFromSizePct(pct) without a current scale keeps the old clamp", () => {
    expect(trackedScaleFromSizePct(2)).toBeCloseTo(0.05, 9);
  });

  it("trackedScaleFromSizePct honors a sub-floor current scale (no 5% snap)", () => {
    // Legacy scale 0.02 shows as 2%; touching the slider at 2% must KEEP 2%.
    expect(trackedScaleFromSizePct(2, 0.02)).toBeCloseTo(0.02, 9);
    // …and still clamps the top end.
    expect(trackedScaleFromSizePct(700, 0.02)).toBe(5);
  });

  it("trackedScaleFromSizePct ratchets back to the standard floor for normal scales", () => {
    expect(trackedScaleFromSizePct(2, 1)).toBeCloseTo(0.05, 9);
  });
});

describe("spinTransformAt", () => {
  const base = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0.1, y: -0.2, z: 1.0 },
  };

  it("pointer straight above the art center ⇒ z = 0 (matches applyRotateDrag's frame)", () => {
    const t = spinTransformAt(base, art, { x: 140, y: 100 });
    expect(t.rotation.z).toBeCloseTo(0, 6);
  });

  it("pointer due right of the center ⇒ z = 90° in radians; x/y rotation + position preserved", () => {
    const t = spinTransformAt(base, art, { x: 300, y: 260 });
    expect(t.rotation.z).toBeCloseTo(Math.PI / 2, 6);
    expect(t.rotation.x).toBe(base.rotation.x);
    expect(t.rotation.y).toBe(base.rotation.y);
    expect(t.position).toEqual(base.position);
  });
});
