import { describe, it, expect } from "vitest";
import {
  applyMoveDrag,
  applyResizeDrag,
  applyRotateDrag,
  type HandleId,
} from "@/lib/preview/overlay-drag-math";

const rect = { x: 100, y: 100, width: 200, height: 100 }; // center (200,150)
// 2x display scale: 1 display px = 0.5 composition px.
const scale = { scaleX: 2, scaleY: 2 };

describe("applyMoveDrag", () => {
  it("translates the rect by the scaled delta", () => {
    const r = applyMoveDrag(rect, { dxDisplay: 40, dyDisplay: 20 }, scale, 0);
    expect(r.x).toBeCloseTo(120, 5); // 100 + 40/2
    expect(r.y).toBeCloseTo(110, 5); // 100 + 20/2
    expect(r.width).toBe(200);
    expect(r.height).toBe(100);
  });

  it("ignores rotation for a pure move (translation commutes)", () => {
    const r = applyMoveDrag(rect, { dxDisplay: 40, dyDisplay: 0 }, scale, 90);
    expect(r.x).toBeCloseTo(120, 5);
    expect(r.y).toBeCloseTo(100, 5);
  });
});

describe("applyResizeDrag", () => {
  it("dragging the SE corner +X grows width by the scaled delta", () => {
    const r = applyResizeDrag(rect, "se", { dxDisplay: 40, dyDisplay: 20 }, scale, 0);
    expect(r.width).toBeCloseTo(220, 5); // 200 + 20
    expect(r.height).toBeCloseTo(110, 5); // 100 + 10
    expect(r.x).toBe(100); // SE corner: x/y unchanged
    expect(r.y).toBe(100);
  });

  it("dragging the NW corner +X shrinks width and moves x", () => {
    const r = applyResizeDrag(rect, "nw", { dxDisplay: 40, dyDisplay: 0 }, scale, 0);
    expect(r.x).toBeCloseTo(120, 5);
    expect(r.width).toBeCloseTo(180, 5);
    expect(r.height).toBe(100);
  });

  it("an edge handle resizes only one axis", () => {
    const r = applyResizeDrag(rect, "e", { dxDisplay: 40, dyDisplay: 40 }, scale, 0);
    expect(r.width).toBeCloseTo(220, 5);
    expect(r.height).toBe(100); // e: vertical untouched
  });

  it("rotation maps the display delta into the overlay's local frame", () => {
    // 90° rotation: dragging the SE handle in +display-Y should grow WIDTH
    // (local +x), not height, because the box is rotated a quarter turn.
    const r = applyResizeDrag(rect, "se", { dxDisplay: 0, dyDisplay: 40 }, scale, 90);
    expect(r.width).toBeGreaterThan(200);
    expect(r.height).toBeCloseTo(100, 1);
  });

  it("never produces a sub-minimum dimension", () => {
    const r = applyResizeDrag(rect, "se", { dxDisplay: -9999, dyDisplay: -9999 }, scale, 0);
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
  });
});

describe("applyRotateDrag", () => {
  it("returns degrees from center to the pointer (0 = straight up)", () => {
    // pointer directly to the right of center → 90° clockwise from up.
    const deg = applyRotateDrag(rect, { compX: 400, compY: 150 });
    expect(deg).toBeCloseTo(90, 3);
  });
  it("pointer directly above center → 0°", () => {
    const deg = applyRotateDrag(rect, { compX: 200, compY: 0 });
    expect(deg).toBeCloseTo(0, 3);
  });
  it("normalizes into [0,360)", () => {
    const deg = applyRotateDrag(rect, { compX: 0, compY: 150 }); // left → 270
    expect(deg).toBeCloseTo(270, 3);
    expect(deg).toBeGreaterThanOrEqual(0);
    expect(deg).toBeLessThan(360);
  });
});
