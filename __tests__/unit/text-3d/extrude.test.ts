import { describe, it, expect } from "vitest";
import { glyphShapesFor } from "@/lib/engine/text-3d/extrude";
import { loadFont } from "@/lib/engine/text-3d/extrude-node";
import { bundledFontFilePath, DEFAULT_3D_FONTS } from "@/lib/engine/text-3d/fonts";

describe("extrude font loading", () => {
  it("parses a bundled TTF into a font with glyphs", async () => {
    const font = await loadFont(bundledFontFilePath(DEFAULT_3D_FONTS[0].file));
    expect(font).toBeTruthy();
  });
  it("produces non-empty contours for visible text", async () => {
    const font = await loadFont(bundledFontFilePath(DEFAULT_3D_FONTS[0].file));
    expect(glyphShapesFor(font, "Hi", 100).length).toBeGreaterThan(0);
  });
  it("returns no shapes for whitespace-only text", async () => {
    const font = await loadFont(bundledFontFilePath(DEFAULT_3D_FONTS[0].file));
    expect(glyphShapesFor(font, "   ", 100).length).toBe(0);
  });
  it("caches a font load by path (same promise)", async () => {
    const p = bundledFontFilePath(DEFAULT_3D_FONTS[1].file);
    const a = loadFont(p);
    const b = loadFont(p);
    expect(a).toBe(b);
  });
  it("nests counter holes inside an outline (the 'o' hole)", async () => {
    const font = await loadFont(bundledFontFilePath(DEFAULT_3D_FONTS[0].file));
    const shapes = glyphShapesFor(font, "o", 200);
    expect(shapes.length).toBeGreaterThan(0);
    const totalHoles = shapes.reduce((n, s) => n + s.holes.length, 0);
    expect(totalHoles).toBeGreaterThan(0);
  });
});
