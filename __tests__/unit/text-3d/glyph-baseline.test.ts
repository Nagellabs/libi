import { describe, it, expect, beforeAll } from "vitest";
import * as THREE from "three";
import type opentype from "opentype.js";
import { glyphShapesFor, buildExtrudedMesh } from "@/lib/engine/text-3d/extrude";
import { loadFont } from "@/lib/engine/text-3d/extrude-node";
import { bundledFontFilePath, DEFAULT_3D_FONTS } from "@/lib/engine/text-3d/fonts";

let font: opentype.Font;

beforeAll(async () => {
  // Same real-font loader path extrude.test.ts uses (node fs → opentype.parse).
  font = await loadFont(bundledFontFilePath(DEFAULT_3D_FONTS[0].file));
});

/** Build one glyph's extruded geometry bbox. Each call uses a UNIQUE cache key so
 *  the shared geometryCache can't leak stale (pre-fix) geometry between cases. */
function glyphBBox(f: opentype.Font, ch: string): import("three").Box3 {
  const shapes = glyphShapesFor(f, ch, 1.0);
  const mesh = buildExtrudedMesh(THREE, shapes, { depth: 0.1 }, `test|${ch}|0.1|0`);
  mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox!;
}

describe("glyph geometry keeps font-intrinsic layout", () => {
  it("non-descender glyphs share the baseline (min.y ≈ 0)", () => {
    for (const ch of ["A", "t", "s", "M"]) {
      expect(Math.abs(glyphBBox(font, ch).min.y)).toBeLessThan(0.03);
    }
  });
  it("descender glyphs extend below the baseline", () => {
    for (const ch of ["g", "j", "p", "y"]) {
      expect(glyphBBox(font, ch).min.y).toBeLessThan(-0.05);
    }
  });
  it("a period sits at the baseline, not vertically centered", () => {
    const bb = glyphBBox(font, ".");
    expect(bb.min.y).toBeGreaterThan(-0.03);
    expect(bb.max.y).toBeLessThan(0.4); // near baseline, NOT at glyph-run center
  });
  it("keeps the left side bearing (min.x >= 0, not centered around 0)", () => {
    const bb = glyphBBox(font, "o");
    expect(bb.min.x).toBeGreaterThanOrEqual(-0.01);
  });
});
