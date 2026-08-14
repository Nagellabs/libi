import { describe, it, expect } from "vitest";
import { applyFitAndScale } from "@/lib/engine/overlay-renderer";

const RECT = { x: 0, y: 0, width: 80, height: 80 };

describe("applyFitAndScale", () => {
  describe('fit "head" — face-like bbox (roughly square)', () => {
    // A real face/object track emits a ~square bbox. Behavior must be
    // unchanged: extend upward by 50% to cover forehead/hair, then scale.
    it("extends a square face bbox upward 50% then scales", () => {
      const r = applyFitAndScale(
        { x: 100, y: 100, w: 80, h: 80 },
        RECT,
        "head",
        1,
      );
      // h: 80 -> 120 (extend up 50%), y: 100 -> 60, centered on that box
      expect(r.h).toBeCloseTo(120, 5);
      expect(r.w).toBeCloseTo(80, 5);
      const cy = r.y + r.h / 2;
      expect(cy).toBeCloseTo(120, 5); // center of [60, 180]
    });
  });

  describe('fit "head" — person/object bbox (tall: h >> w)', () => {
    // The dogfood bug: a full-body person track (objectKind "object",
    // class "person") emits a tall bbox. fit:"head" used to scale the
    // emoji to the WHOLE body height → a frame-filling emoji. It must
    // instead isolate a head-sized region near the top-center.
    it("isolates a small head region near the top-center, not the whole body", () => {
      const sample = { x: 84, y: 183, w: 143, h: 324 }; // the live Lisa person box
      const r = applyFitAndScale(sample, RECT, "head", 1.1);

      // Head region must be MUCH smaller than the person bbox — nowhere
      // near the 324px body height that produced the frame-fill.
      expect(r.h).toBeLessThan(120);
      expect(r.w).toBeLessThan(120);
      expect(r.h).toBeGreaterThan(20);

      // Roughly square (a head), not a tall body slab.
      expect(Math.abs(r.w - r.h)).toBeLessThan(5);

      // Horizontally centered on the person bbox center.
      const personCx = sample.x + sample.w / 2;
      const headCx = r.x + r.w / 2;
      expect(headCx).toBeCloseTo(personCx, 5);

      // Vertically anchored near the TOP of the person bbox (the head),
      // not its vertical center.
      const headCy = r.y + r.h / 2;
      expect(headCy).toBeLessThan(sample.y + sample.h * 0.35);
      expect(headCy).toBeGreaterThanOrEqual(sample.y);
    });

    it("applies the scale multiplier to the derived head box", () => {
      const sample = { x: 84, y: 183, w: 143, h: 324 };
      const a = applyFitAndScale(sample, RECT, "head", 1);
      const b = applyFitAndScale(sample, RECT, "head", 2);
      expect(b.w).toBeCloseTo(a.w * 2, 5);
      expect(b.h).toBeCloseTo(a.h * 2, 5);
      // Same center regardless of scale.
      expect(b.x + b.w / 2).toBeCloseTo(a.x + a.w / 2, 5);
      expect(b.y + b.h / 2).toBeCloseTo(a.y + a.h / 2, 5);
    });
  });

  describe('fit "tight" and "rect" unchanged', () => {
    it('"tight" scales relative to the raw bbox, centered', () => {
      const r = applyFitAndScale({ x: 10, y: 20, w: 40, h: 60 }, RECT, "tight", 2);
      expect(r.w).toBeCloseTo(80, 5);
      expect(r.h).toBeCloseTo(120, 5);
      expect(r.x + r.w / 2).toBeCloseTo(30, 5);
      expect(r.y + r.h / 2).toBeCloseTo(50, 5);
    });

    it('"rect" uses overlay rect dims scaled, centered on bbox center', () => {
      const r = applyFitAndScale({ x: 0, y: 0, w: 200, h: 400 }, RECT, "rect", 1.5);
      expect(r.w).toBeCloseTo(120, 5); // 80 * 1.5
      expect(r.h).toBeCloseTo(120, 5);
      expect(r.x + r.w / 2).toBeCloseTo(100, 5);
      expect(r.y + r.h / 2).toBeCloseTo(200, 5);
    });
  });

  describe("frame clamp — no overlay can ever fill the screen", () => {
    const FRAME = { width: 360, height: 640 };

    it("clamps a pathological tight box to <=66% of the frame, centered", () => {
      // Degenerate near-frame box at huge scale — must not blow up.
      const r = applyFitAndScale(
        { x: 10, y: 20, w: 340, h: 600 },
        RECT,
        "tight",
        3,
        FRAME,
      );
      expect(r.w).toBeLessThanOrEqual(0.66 * 360 + 0.001);
      expect(r.h).toBeLessThanOrEqual(0.66 * 640 + 0.001);
      // Aspect preserved (uniform shrink) and center kept.
      expect(r.w / r.h).toBeCloseTo(340 / 600, 2);
      expect(r.x + r.w / 2).toBeCloseTo(10 + 340 / 2, 3);
      expect(r.y + r.h / 2).toBeCloseTo(20 + 600 / 2, 3);
    });

    it("the live t≈5 wide box (309x405, ratio 1.31) is treated as person-like and yields a small head, not a frame-fill", () => {
      const r = applyFitAndScale(
        { x: 25, y: 110, w: 309, h: 405 },
        RECT,
        "head",
        1.1,
        FRAME,
      );
      // Was the bug: 405*1.5*1.1 ≈ 668 (frame-filling). Now head-derived.
      expect(r.h).toBeLessThan(0.66 * 640);
      expect(r.w).toBeLessThan(0.66 * 360);
      expect(Math.abs(r.w - r.h)).toBeLessThan(5); // square head
      expect(r.h).toBeLessThan(140);
    });

    it("a raised arm (abnormally tall person box) does NOT balloon the head — capped by a width bound", () => {
      const normal = { x: 100, y: 150, w: 120, h: 360 }; // standing
      const armUp = { x: 100, y: 40, w: 122, h: 620 }; // hand overhead: box grew TALL, width ~same
      const rN = applyFitAndScale(normal, RECT, "head", 1);
      const rA = applyFitAndScale(armUp, RECT, "head", 1);
      // Height-only sizing would give 0.22*620=136 (≈ +72% vs the 79 of
      // the normal box). The width cap (0.9*122≈110) holds it close to
      // normal so the emoji doesn't visibly balloon for that ~1s.
      expect(rA.h).toBeLessThanOrEqual(0.9 * 122 + 0.001);
      expect(rA.h / rN.h).toBeLessThan(1.45); // not the ~1.7x of height-only
      expect(rA.w).toBeCloseTo(rA.h, 5); // still a square head
    });

    it("normal head emoji (small face box) is unaffected by the clamp", () => {
      const r = applyFitAndScale(
        { x: 150, y: 90, w: 70, h: 80 },
        RECT,
        "head",
        1.2,
        FRAME,
      );
      // ~ (80*1.5)*1.2 = 144 tall — well under the clamp, untouched.
      expect(r.h).toBeCloseTo(80 * 1.5 * 1.2, 3);
      expect(r.w).toBeCloseTo(70 * 1.2, 3);
    });
  });
});
