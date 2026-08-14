import { describe, it, expect } from "vitest";
import { offsetFromDrop } from "@/lib/preview/tracked-offset-drag";
import { resolveTrackedRect, applyFitAndScale } from "@/lib/engine/overlay-renderer";

const frame = { width: 608, height: 1080 };
const rect = { x: 0, y: 0, width: 608, height: 1080 };
const sample = { x: 200, y: 400, w: 100, h: 200 };

describe("offsetFromDrop", () => {
  it("dropping at the un-offset art center yields the zero offset", () => {
    const base = applyFitAndScale(sample, rect, "tight", 1, frame);
    const drop = { x: base.x + base.w / 2, y: base.y + base.h / 2 };
    expect(offsetFromDrop({ sample, rect, fit: "tight", scale: 1, frame, drop })).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("round-trips: resolveTrackedRect(offsetFromDrop(drop)) centers exactly at drop", () => {
    const drop = { x: 250, y: 180 };
    const off = offsetFromDrop({ sample, rect, fit: "head", scale: 1.5, frame, drop });
    const r = resolveTrackedRect(sample, { rect, fit: "head", scale: 1.5, offset: off }, frame);
    expect(r.x + r.w / 2).toBeCloseTo(drop.x, 6);
    expect(r.y + r.h / 2).toBeCloseTo(drop.y, 6);
  });

  it("clamps a far drop of a small box to the ±10 persistence bound (TrackedOffsetSchema)", () => {
    // A ~30px box dragged hundreds of px produces a raw offset far beyond the
    // schema's min(-10)/max(10) — unclamped, the PATCH would 400 and the edit
    // silently reverts on reload.
    const small = { x: 300, y: 500, w: 30, h: 30 };
    const off = offsetFromDrop({
      sample: small, rect, fit: "tight", scale: 1, frame, drop: { x: 900, y: 40 },
    });
    expect(off.x).toBeLessThanOrEqual(10);
    expect(off.x).toBeGreaterThanOrEqual(-10);
    expect(off.y).toBeLessThanOrEqual(10);
    expect(off.y).toBeGreaterThanOrEqual(-10);
    // The drag really was out of range on both axes — the clamp engaged.
    expect(off.x).toBe(10);
    expect(off.y).toBe(-10);
  });

  it("clamp is inert for a normal in-range drop", () => {
    const base = applyFitAndScale(sample, rect, "tight", 1, frame);
    const drop = { x: base.x + base.w / 2 + base.w * 0.5, y: base.y + base.h / 2 - base.h * 0.25 };
    const off = offsetFromDrop({ sample, rect, fit: "tight", scale: 1, frame, drop });
    expect(off.x).toBeCloseTo(0.5, 6);
    expect(off.y).toBeCloseTo(-0.25, 6);
  });

  it("degenerate art box (zero-size sample) yields zero offset instead of NaN", () => {
    const zero = { x: 10, y: 10, w: 0, h: 0 };
    const off = offsetFromDrop({
      sample: zero, rect, fit: "tight", scale: 1, frame, drop: { x: 300, y: 300 },
    });
    expect(off).toEqual({ x: 0, y: 0 });
  });
});
