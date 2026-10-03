/**
 * Template reflow math (lib/templates/reflow.ts): each layer's rect re-anchored from the template's
 * frame into the piece's, type scaled with it, keyframed rects carried along, kept in the safe area.
 * Pure, so every expectation is worked out by hand from the rules in the module header.
 */
import { describe, it, expect } from "vitest";
import { framesDiffer, mapPointBetweenRects, mapRect, reflowLayer, reflowScale } from "@/lib/templates/reflow";
import { followRect, followRectKeyframes } from "@/lib/overlays/keyframe-follow";

const LANDSCAPE = { width: 1920, height: 1080 };
const PORTRAIT = { width: 1080, height: 1920 };
const SQUARE = { width: 1080, height: 1080 };

describe("reflow scale and frames", () => {
  it("scales by the short sides", () => {
    expect(reflowScale(LANDSCAPE, PORTRAIT)).toBe(1);
    expect(reflowScale(PORTRAIT, SQUARE)).toBe(1);
    expect(reflowScale({ width: 1920, height: 1080 }, { width: 1280, height: 720 })).toBeCloseTo(2 / 3, 6);
  });
  it("differs on aspect or on size, not on identical frames", () => {
    expect(framesDiffer(LANDSCAPE, PORTRAIT)).toBe(true);
    expect(framesDiffer(LANDSCAPE, { width: 1280, height: 720 })).toBe(true);
    expect(framesDiffer(LANDSCAPE, { ...LANDSCAPE })).toBe(false);
  });
});

describe("mapRect 16:9 → 9:16", () => {
  it("keeps a centred layer centred and shrinks one that is wider than the safe area", () => {
    const m = mapRect({ x: 360, y: 440, width: 1200, height: 200 }, LANDSCAPE, PORTRAIT);
    expect(m.rect).toEqual({ x: 54, y: 879, width: 972, height: 162 });
    expect(m.scale).toBeCloseTo(0.81, 6);
    expect(m.shrunk).toBe(true);
  });
  it("keeps a bottom-left layer at the bottom-left, pulled in to the 5% safe margin of the taller frame", () => {
    const m = mapRect({ x: 100, y: 880, width: 600, height: 120 }, LANDSCAPE, PORTRAIT);
    // Its own bottom margin (80 px) is under 5% of 1920 (96 px), so it sits at 96.
    expect(m.rect).toEqual({ x: 100, y: 1704, width: 600, height: 120 });
    expect(m.shrunk).toBe(false);
  });
  it("keeps a top-right logo in the top-right corner, hugging an edge it already hugged", () => {
    const m = mapRect({ x: 1700, y: 40, width: 160, height: 160 }, LANDSCAPE, PORTRAIT);
    expect(m.rect).toEqual({ x: 860, y: 40, width: 160, height: 160 });
  });
  it("makes a full-frame backdrop fill the new frame", () => {
    const m = mapRect({ x: 0, y: 0, width: 1920, height: 1080 }, LANDSCAPE, PORTRAIT);
    expect(m.rect).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
    expect(m.spansX && m.spansY).toBe(true);
  });
  it("makes a full-width band span the new width and keeps it on the bottom edge", () => {
    const m = mapRect({ x: 0, y: 900, width: 1920, height: 100 }, LANDSCAPE, PORTRAIT);
    expect(m.rect).toEqual({ x: 0, y: 1724, width: 1080, height: 100 });
  });
});

describe("mapRect 9:16 → 1:1", () => {
  it("keeps a top layer near the top and a bottom layer near the bottom", () => {
    expect(mapRect({ x: 90, y: 300, width: 900, height: 200 }, PORTRAIT, SQUARE).rect).toEqual({ x: 90, y: 300, width: 900, height: 200 });
    expect(mapRect({ x: 90, y: 1600, width: 900, height: 200 }, PORTRAIT, SQUARE).rect).toEqual({ x: 90, y: 760, width: 900, height: 200 });
  });
  it("scales a column taller than the frame down uniformly and keeps it inside the safe area", () => {
    const m = mapRect({ x: 440, y: 100, width: 200, height: 1700 }, PORTRAIT, SQUARE);
    expect(m.rect.height).toBeCloseTo(972, 6);
    expect(m.rect.width).toBeCloseTo(114.35, 1);
    expect(m.rect.y).toBeCloseTo(54, 6);
    expect(m.rect.x + m.rect.width / 2).toBeCloseTo(540, 0);
  });
});

describe("mapRect on a smaller frame of the same shape", () => {
  it("is a uniform scale", () => {
    const m = mapRect({ x: 960, y: 540, width: 480, height: 270 }, LANDSCAPE, { width: 1280, height: 720 });
    expect(m.rect.x).toBeCloseTo(640, 6);
    expect(m.rect.y).toBeCloseTo(360, 6);
    expect(m.rect.width).toBeCloseTo(320, 6);
    expect(m.rect.height).toBeCloseTo(180, 6);
  });
});

describe("reflowLayer text", () => {
  const text = {
    kind: "text",
    rect: { x: 360, y: 440, width: 1200, height: 200 },
    content: "Hello",
    font: "700 100px Inter, sans-serif",
    fontSize: 100,
    position: { x: 960, y: 540 },
    anchor: "mid-center",
    maxWidthPct: 0.6,
    stroke: { color: "#000", width: 10 },
    shadow: { color: "#000", blur: 20, dx: 0, dy: 8 },
    background: { color: "#111", padding: 20, radius: 10 },
  };
  it("scales type with the layer and carries the point and the wrap", () => {
    const { layer, warnings } = reflowLayer(text, LANDSCAPE, PORTRAIT, 'layer "title"');
    expect(layer.rect).toEqual({ x: 54, y: 879, width: 972, height: 162 });
    expect(layer.fontSize).toBe(81);
    expect(layer.font).toBe("700 81px Inter, sans-serif");
    expect(layer.position).toEqual({ x: 540, y: 960 });
    expect(layer.stroke).toEqual({ color: "#000", width: 8.1 });
    expect(layer.shadow).toEqual({ color: "#000", blur: 16.2, dx: 0, dy: 6.48 });
    expect(layer.background).toEqual({ color: "#111", padding: 16.2, radius: 8.1 });
    expect(layer.maxWidthPct).toBeCloseTo(0.864, 3);
    expect(warnings).toEqual(['layer "title": scaled down to fit inside this frame\'s safe area']);
  });
  it("caps a wrap that would run past the safe width, and says so", () => {
    const { layer, warnings } = reflowLayer({ ...text, maxWidthPct: 0.9 }, LANDSCAPE, PORTRAIT, "t");
    expect(layer.maxWidthPct).toBe(0.9);
    expect(warnings.some((w) => w.includes("wraps at the safe width"))).toBe(true);
  });
  it("leaves the input untouched", () => {
    const copy = structuredClone(text);
    reflowLayer(text, LANDSCAPE, PORTRAIT, "t");
    expect(text).toEqual(copy);
  });
  it("keeps a full-width text box's wrap fraction", () => {
    const box = { kind: "text", rect: { x: 0, y: 0, width: 1920, height: 200 }, font: "64px Inter", maxWidthPct: 0.8 };
    expect(reflowLayer(box, LANDSCAPE, PORTRAIT, "t").layer.maxWidthPct).toBe(0.8);
  });
});

describe("reflowLayer keyframes", () => {
  it("translates and scales a keyframed rect with its overlay", () => {
    const layer = {
      kind: "text",
      rect: { x: 360, y: 440, width: 1200, height: 200 },
      font: "100px Inter",
      keyframes: {
        rect: {
          keyframes: [
            { t: 0, value: { x: 360, y: 640, width: 1200, height: 200 }, easing: "ease-out" },
            { t: 1, value: { x: 360, y: 440, width: 1200, height: 200 } },
          ],
        },
        opacity: { keyframes: [{ t: 0, value: 0 }, { t: 1, value: 1 }] },
      },
    };
    const { layer: out } = reflowLayer(layer, LANDSCAPE, PORTRAIT, "t");
    const kf = out.keyframes as typeof layer.keyframes;
    expect(kf.rect.keyframes[0]).toEqual({ t: 0, value: { x: 54, y: 1041, width: 972, height: 162 }, easing: "ease-out" });
    // The end key sat on the base rect, so it lands on the new one.
    expect(kf.rect.keyframes[1]!.value).toEqual(out.rect);
    expect(kf.opacity).toEqual(layer.keyframes.opacity);
  });
  it("scales a 3D offset and leaves rotation alone", () => {
    const layer = {
      kind: "image",
      rect: { x: 100, y: 100, width: 1600, height: 800 },
      transform3d: { position: { x: 100, y: -50, z: 7 }, rotation: { x: 0, y: 0, z: 1 } },
    };
    const { layer: out } = reflowLayer(layer, LANDSCAPE, PORTRAIT, "t");
    const k = (out.rect as { width: number }).width / 1600;
    expect(k).toBeLessThan(1);
    const t3 = out.transform3d as typeof layer.transform3d;
    expect(t3.position.x).toBeCloseTo(100 * k, 1);
    expect(t3.position.z).toBe(7);
    expect(t3.rotation).toEqual(layer.transform3d.rotation);
  });
});

describe("reflowLayer code", () => {
  it("warns that a body written for the template's frame needs a look", () => {
    const { warnings } = reflowLayer({ kind: "code", rect: { x: 0, y: 0, width: 1920, height: 1080 } }, LANDSCAPE, PORTRAIT, 'layer "fx"');
    expect(warnings).toEqual([expect.stringContaining('layer "fx": its code draws for the template\'s 1920×1080 frame')]);
  });
});

describe("keyframe follow", () => {
  const base = { x: 100, y: 100, width: 200, height: 100 };
  it("translates when the base only moves", () => {
    expect(followRect({ x: 150, y: 120, width: 200, height: 100 }, base, { ...base, x: 400, y: 50 })).toEqual({ x: 450, y: 70, width: 200, height: 100 });
  });
  it("scales offsets and sizes when the base is resized", () => {
    expect(followRect({ x: 200, y: 100, width: 200, height: 100 }, base, { x: 100, y: 100, width: 400, height: 50 })).toEqual({ x: 300, y: 100, width: 400, height: 50 });
  });
  it("returns the same object when nothing changes or there is no rect track", () => {
    const kf = { rect: { keyframes: [{ t: 0, value: base }] } };
    expect(followRectKeyframes(kf, base, { ...base })).toBe(kf);
    const none = { opacity: { keyframes: [{ t: 0, value: 1 }] } };
    expect(followRectKeyframes(none, base, { ...base, x: 5 })).toBe(none);
    expect(followRectKeyframes(undefined, base, base)).toBeUndefined();
  });
  it("maps a point inside a box to the same relative place in another", () => {
    expect(mapPointBetweenRects({ x: 150, y: 150 }, base, { x: 0, y: 0, width: 400, height: 100 })).toEqual({ x: 100, y: 50 });
  });
});
