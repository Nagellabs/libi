import { describe, it, expect } from "vitest";
import { clampRectToFrame } from "@/lib/engine/overlays";

describe("clampRectToFrame", () => {
  it("caps an oversized rect's size to the frame", () => {
    const r = clampRectToFrame({ x: -50, y: 0, width: 2200, height: 300 }, 1920, 1080);
    // Size is capped to the frame...
    expect(r.width).toBe(1920);
    expect(r.height).toBe(300);
    // ...and the now frame-filling width may keep a small negative offset so a
    // user-positioned full-frame box stays draggable (not snapped to 0).
    expect(r.x).toBe(-50);
    // The sub-frame height is still kept fully inside.
    expect(r.y).toBe(0);
    expect(r.y + r.height).toBeLessThanOrEqual(1080);
  });

  it("keeps a positioned frame-filling rect's offset instead of snapping x/y to 0", () => {
    // Issue 1 regression: a `three` overlay's default rect fills the canvas;
    // dragging X/Y must STICK. The old [0, frame-size] range collapsed to 0.
    const r = clampRectToFrame({ x: 200, y: 150, width: 720, height: 1280 }, 720, 1280);
    expect(r).toEqual({ x: 200, y: 150, width: 720, height: 1280 });
  });
  it("shifts an in-bounds-size but off-right rect back inside", () => {
    const r = clampRectToFrame({ x: 1900, y: 1000, width: 200, height: 200 }, 1920, 1080);
    expect(r.x + r.width).toBeLessThanOrEqual(1920);
    expect(r.y + r.height).toBeLessThanOrEqual(1080);
    expect(r.width).toBe(200);
    expect(r.height).toBe(200);
  });
  it("leaves a fully-in-frame rect unchanged", () => {
    const rect = { x: 100, y: 100, width: 400, height: 200 };
    expect(clampRectToFrame(rect, 1920, 1080)).toEqual(rect);
  });
  it("no-ops when frame dims are zero", () => {
    const rect = { x: -50, y: 0, width: 5000, height: 5000 };
    expect(clampRectToFrame(rect, 0, 0)).toEqual(rect);
  });
});
