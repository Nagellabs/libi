import { describe, it, expect } from "vitest";
import { captionPlateRect } from "@/lib/engine/overlay-renderer";

/**
 * The caption background plate must hug the measured glyph INK box (inkTop /
 * inkBottom) plus symmetric padding — NOT the font's reserved ascent/descent or
 * the line-height box, which over-reserve space below the glyphs (the
 * "background overflows below the caption" bug). e.g. for 88px bold serif the
 * real glyph descent is ~70px, not 88.
 */
describe("captionPlateRect", () => {
  const base = {
    rectX: 0,
    rectWidth: 1000,
    inkTop: 10,
    inkBottom: 80, // 70px of visible ink
    widest: 400,
    pad: 16,
    align: "center" as const,
  };

  it("pads the ink box symmetrically (gap above === gap below === pad)", () => {
    const r = captionPlateRect(base);
    expect(base.inkTop - r.y).toBe(base.pad); // gap above ink
    expect(r.y + r.height - base.inkBottom).toBe(base.pad); // gap below ink
  });

  it("sizes height to ink extent + 2*pad (not fontSize/lineHeight)", () => {
    const r = captionPlateRect(base);
    expect(r.height).toBe(80 - 10 + 2 * 16); // 102
  });

  it("sizes width to widest line + 2*pad", () => {
    const r = captionPlateRect(base);
    expect(r.width).toBe(400 + 2 * 16); // 432
  });

  it("positions x by alignment", () => {
    expect(captionPlateRect({ ...base, align: "left" }).x).toBe(0);
    expect(captionPlateRect({ ...base, align: "right" }).x).toBe(1000 - 432);
    expect(captionPlateRect({ ...base, align: "center" }).x).toBe(1000 / 2 - 432 / 2);
  });

  it("never produces negative height when bounds collapse", () => {
    const r = captionPlateRect({ ...base, inkTop: 50, inkBottom: 50 });
    expect(r.height).toBe(2 * 16);
  });
});
