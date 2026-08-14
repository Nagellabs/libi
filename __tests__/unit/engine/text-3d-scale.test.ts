import { describe, it, expect } from "vitest";
import { normalizeThreeDForWorld, fitScaleForFrame } from "@/lib/engine/text-3d/scale";
import { easeInOutQuad, flythroughFrame, glyphPainted } from "@/lib/engine/text-3d/flythrough";

/**
 * Regression: author depth/bevel are a pixel-ish "amount" (inspector default 20,
 * agent uses 24–30) but the 3D-text builder works in world units where a glyph
 * is ~1.0 tall. Fed raw, depth:30 extruded a 0.7-unit glyph 30 deep (a red rod)
 * and faux built 12 ghost planes spanning 24 units. These tests pin the
 * normalization that makes any author magnitude render as tasteful 3D text.
 */
describe("normalizeThreeDForWorld", () => {
  const FONT = 1.0;

  it("maps the inspector default (20) to ~20% of the em", () => {
    const { worldDepth } = normalizeThreeDForWorld(20, 0, FONT);
    expect(worldDepth).toBeCloseTo(0.2, 5);
  });

  it("keeps author values like 24/30 in a legible range (not a 24–30u rod)", () => {
    expect(normalizeThreeDForWorld(24, 0, FONT).worldDepth).toBeCloseTo(0.24, 5);
    expect(normalizeThreeDForWorld(30, 0, FONT).worldDepth).toBeCloseTo(0.3, 5);
  });

  it("clamps an extreme depth to ≤60% of the em", () => {
    expect(normalizeThreeDForWorld(500, 0, FONT).worldDepth).toBe(0.6);
  });

  it("caps bevel at 35% of the resolved depth so it never engulfs the glyph", () => {
    // bevel:3 (author) would be 4× a glyph; capped relative to depth instead.
    const { worldDepth, worldBevel } = normalizeThreeDForWorld(30, 3, FONT);
    expect(worldBevel).toBeCloseTo(0.03, 5); // 3/100 * 1.0, under the 0.35*depth cap
    expect(worldBevel).toBeLessThanOrEqual(worldDepth * 0.35 + 1e-9);
  });

  it("caps a huge bevel to 35% of depth", () => {
    const { worldDepth, worldBevel } = normalizeThreeDForWorld(20, 100, FONT);
    expect(worldBevel).toBeCloseTo(worldDepth * 0.35, 5);
  });

  it("scales faux layer count with depth, clamped to [3,10] (no 12-plane ghosting)", () => {
    expect(normalizeThreeDForWorld(0, 0, FONT).fauxLayers).toBe(3);
    expect(normalizeThreeDForWorld(24, 0, FONT).fauxLayers).toBe(8); // round(24/4)+2
    expect(normalizeThreeDForWorld(200, 0, FONT).fauxLayers).toBe(10);
  });

  it("treats negative / non-finite inputs as 0", () => {
    expect(normalizeThreeDForWorld(-5, -1, FONT).worldDepth).toBe(0);
    expect(normalizeThreeDForWorld(NaN, NaN, FONT).worldDepth).toBe(0);
    expect(normalizeThreeDForWorld(Infinity, 0, FONT).worldDepth).toBe(0);
  });

  it("scales with a non-unit world font size", () => {
    expect(normalizeThreeDForWorld(20, 0, 2.0).worldDepth).toBeCloseTo(0.4, 5);
  });
});

describe("fitScaleForFrame", () => {
  // Billboard preset: fov 50°, camera at z=6 → visible half-height tan(25°)*6 ≈ 2.80.
  const FOV = 50;
  const DIST = 6;

  it("scales a small word UP to fill ~78% of the frame height (was ~13%)", () => {
    // A 0.7-tall, 2.8-wide word in a wide (5:1) box is height-bound.
    const s = fitScaleForFrame(2.8, 0.7, FOV, DIST, 5.0);
    // height target: 2*2.80*0.78 / 0.7 ≈ 6.24
    expect(s).toBeCloseTo(6.24, 1);
    // sanity: scaled text height ≈ 78% of the ~5.6u visible height
    const halfH = Math.tan((FOV * Math.PI) / 180 / 2) * DIST;
    expect((0.7 * s) / (2 * halfH)).toBeCloseTo(0.78, 2);
  });

  it("is width-bound for a long word in a narrow box (neither axis overflows)", () => {
    const s = fitScaleForFrame(10, 0.7, FOV, DIST, 0.5); // very wide text, tall narrow box
    const halfH = Math.tan((FOV * Math.PI) / 180 / 2) * DIST;
    const halfW = halfH * 0.5;
    expect(s).toBeCloseTo((2 * halfW * 0.78) / 10, 4); // picked width, not height
    expect(s).toBeLessThan((2 * halfH * 0.78) / 0.7); // height would have allowed more
  });

  it("returns 1 for degenerate inputs (empty text / zero distance)", () => {
    expect(fitScaleForFrame(0, 0.7, FOV, DIST, 1)).toBe(1);
    expect(fitScaleForFrame(2.8, 0, FOV, DIST, 1)).toBe(1);
    expect(fitScaleForFrame(2.8, 0.7, FOV, 0, 1)).toBe(1);
  });
});

describe("flythrough camera motion", () => {
  it("easeInOutQuad is clamped and symmetric at the endpoints/middle", () => {
    expect(easeInOutQuad(0)).toBe(0);
    expect(easeInOutQuad(1)).toBe(1);
    expect(easeInOutQuad(0.5)).toBeCloseTo(0.5, 5);
    expect(easeInOutQuad(-1)).toBe(0); // clamped
    expect(easeInOutQuad(2)).toBe(1); // clamped
  });

  it("paint-front sweeps monotonically left→right, starting AT the first glyph and ending past the last", () => {
    const W = 12; // a long word like JUSTIIIIN
    const f0 = flythroughFrame(0, W);
    const f5 = flythroughFrame(0.5, W);
    const f1 = flythroughFrame(1, W);
    expect(f0.writeFront).toBeCloseTo(-W / 2, 5); // starts at the first glyph (paints from t=0)
    expect(f5.writeFront).toBeGreaterThan(f0.writeFront);
    expect(f1.writeFront).toBeGreaterThan(f5.writeFront);
    expect(f1.writeFront).toBeGreaterThanOrEqual(W / 2); // past the last glyph (finishes on it)
  });

  it("camera tracks from a SIDE/behind offset and looks toward the painting letter (profile view)", () => {
    const f = flythroughFrame(0.5, 12);
    expect(f.camX).toBeLessThan(f.writeFront); // camera sits to the side/behind the active letter
    expect(f.lookX).toBeCloseTo(f.writeFront, 5); // frames the active letter
    expect(f.camZ).toBeGreaterThan(0); // in front of the wall (z=0 plane)
  });

  it("glyphPainted: false ahead of the front, true once the front reaches the glyph (no ramp)", () => {
    expect(glyphPainted(0, 1)).toBe(false); // glyph ahead of the front
    expect(glyphPainted(0, 0)).toBe(true); // front exactly at the glyph
    expect(glyphPainted(5, 0)).toBe(true); // front well past
  });

  it("at progress 0 every glyph of a centered word is unpainted; at 1 every glyph is painted", () => {
    const W = 10;
    // Glyph CENTERS are always inset from the word edges by ~half a glyph.
    const xs = [-4.5, -2, 0, 2, 4.5];
    const f0 = flythroughFrame(0, W);
    const f1 = flythroughFrame(1, W);
    expect(xs.every((x) => glyphPainted(f0.writeFront, x) === false)).toBe(true);
    expect(xs.every((x) => glyphPainted(f1.writeFront, x) === true)).toBe(true);
  });
});

describe("flythroughFrame direction", () => {
  const W = 12;
  it("ltr (default) sweeps left→right, camera on the -x side", () => {
    const a = flythroughFrame(0.1, W);
    const b = flythroughFrame(0.9, W);
    expect(b.writeFront).toBeGreaterThan(a.writeFront);     // sweeps right
    expect(a.camX).toBeLessThan(a.writeFront);              // camera behind/left
  });
  it("rtl sweeps right→left, camera on the +x side", () => {
    const a = flythroughFrame(0.1, W, { direction: "rtl" });
    const b = flythroughFrame(0.9, W, { direction: "rtl" });
    expect(b.writeFront).toBeLessThan(a.writeFront);        // sweeps left
    expect(a.camX).toBeGreaterThan(a.writeFront);           // camera on the +x side
  });
  it("through keeps the camera centered in x and ramps camZ near the middle", () => {
    const start = flythroughFrame(0.02, W, { direction: "through" });
    const mid = flythroughFrame(0.5, W, { direction: "through" });
    expect(Math.abs(mid.camX)).toBeLessThan(0.3);           // ~centered in x
    expect(mid.camZ).toBeLessThan(start.camZ);              // flies closer through the middle
  });
  it("sideOffset widens the camera's x distance from the active letter (ltr)", () => {
    const near = flythroughFrame(0.5, W, { sideOffset: 0.4 });
    const far = flythroughFrame(0.5, W, { sideOffset: 2.0 });
    expect(near.writeFront - near.camX).toBeCloseTo(0.4, 5);
    expect(far.writeFront - far.camX).toBeCloseTo(2.0, 5);
  });
  it("rtl paints glyphs from the right edge first", () => {
    const f = flythroughFrame(0.05, W, { direction: "rtl" });
    expect(glyphPainted(f.writeFront, W / 2 - 0.2, "rtl")).toBe(true);   // rightmost glyph painted early
    expect(glyphPainted(f.writeFront, -W / 2 + 0.2, "rtl")).toBe(false); // leftmost not yet
  });
});
