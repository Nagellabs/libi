import { describe, it, expect } from "vitest";
import { DEFAULT_ROUGH_RENDER, DEFAULT_BLOCK_DRIVEN_RENDER } from "@/lib/storyboard/default-render-unit";
import { renderCanvasUnit } from "@/lib/storyboard/render/canvas";

const isPng = (b: Buffer) =>
  b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

describe("DEFAULT_ROUGH_RENDER", () => {
  it("is a non-empty canvas unit body distinct from the boxes default", () => {
    expect(DEFAULT_ROUGH_RENDER.trim().length).toBeGreaterThan(0);
    expect(DEFAULT_ROUGH_RENDER).not.toBe(DEFAULT_BLOCK_DRIVEN_RENDER);
    expect(DEFAULT_ROUGH_RENDER).not.toMatch(/\bh\(/);
  });

  it("renders to a PNG through the canvas unit path", async () => {
    const png = await renderCanvasUnit(DEFAULT_ROUGH_RENDER, { width: 720, height: 1280 }, {
      blocks: [],
      camera: { shot: "wide" },
    });
    expect(isPng(png)).toBe(true);
    expect(png.length).toBeGreaterThan(100);
  });
});
