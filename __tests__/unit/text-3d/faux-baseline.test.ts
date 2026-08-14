// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as THREE from "three";
import { makeCanvasTextClass } from "@/lib/engine/canvas-text";
import { buildFauxText, type FauxOpts } from "@/lib/engine/text-3d/faux";

/** Per-glyph mock font metrics (canvas px at draw scale). 'o' has ~no descender;
 *  'g' has a deep descender. The ascents are EQUAL so the only difference between
 *  the two glyphs is the descender — which is exactly what the baseline fix must
 *  compensate for. */
const METRICS: Record<string, { ascent: number; descent: number; width: number }> = {
  o: { ascent: 100, descent: 0, width: 90 },
  g: { ascent: 100, descent: 60, width: 95 },
};

/** Minimal 2D-context stub: canvas-text.ts's sync() only reads measureText's
 *  width/ascent/descent and writes text/style props. */
function makeCtx(): CanvasRenderingContext2D {
  return {
    font: "",
    textAlign: "center",
    textBaseline: "middle",
    fillStyle: "#000",
    strokeStyle: "#000",
    lineJoin: "round",
    lineWidth: 1,
    shadowColor: "transparent",
    shadowBlur: 0,
    clearRect: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    measureText: (s: string) => {
      const m = METRICS[s] ?? { ascent: 80, descent: 20, width: s.length * 50 };
      return {
        width: m.width,
        actualBoundingBoxAscent: m.ascent,
        actualBoundingBoxDescent: m.descent,
      } as TextMetrics;
    },
  } as unknown as CanvasRenderingContext2D;
}

let createSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  const original = Document.prototype.createElement;
  createSpy = vi.spyOn(document, "createElement").mockImplementation(function (
    this: Document,
    tag: string,
    ...rest: unknown[]
  ) {
    if (tag === "canvas") {
      // A fake canvas: stores width/height and hands out a stubbed 2D ctx.
      return { width: 2, height: 2, getContext: () => makeCtx() } as unknown as HTMLElement;
    }
    return (original as (t: string, ...r: unknown[]) => HTMLElement).call(this, tag, ...rest);
  } as typeof document.createElement);
});

afterEach(() => {
  createSpy.mockRestore();
});

/** World-unit baseline offset for a glyph (CanvasText default fontSize = 1). This
 *  is the distance from the middle-anchored plane's CENTER down to the baseline,
 *  i.e. how far up the plane must move so the baseline lands at the mesh origin. */
function expectedOffset(ascent: number, descent: number): number {
  return ((ascent - descent) / 2) / (ascent + descent); // fontSize = 1
}

function frontLayerY(group: import("three").Group): number {
  // buildFauxText stacks N identical-content layers; all share the same y.
  return group.children[group.children.length - 1].position.y;
}

describe("faux glyph planes align on the font baseline", () => {
  const CanvasText = makeCanvasTextClass(THREE);
  const opts = (content: string): FauxOpts => ({
    content,
    color: "#ffffff",
    depth: 4,
    layers: 3,
  });

  it("a descender-free glyph sits HIGHER than a deep-descender glyph", () => {
    const oy = frontLayerY(buildFauxText(THREE, CanvasText, opts("o")));
    const gy = frontLayerY(buildFauxText(THREE, CanvasText, opts("g")));
    // Before the fix both were 0 (center-anchored) → this strict inequality fails.
    expect(oy).toBeGreaterThan(gy);
  });

  it("each plane's y equals its measured (ascent−descent)/2 baseline offset", () => {
    const oy = frontLayerY(buildFauxText(THREE, CanvasText, opts("o")));
    const gy = frontLayerY(buildFauxText(THREE, CanvasText, opts("g")));
    expect(oy).toBeCloseTo(expectedOffset(100, 0), 5); // 0.5
    expect(gy).toBeCloseTo(expectedOffset(100, 60), 5); // 0.125
  });

  it("every stacked layer of a glyph shares the same baseline y", () => {
    const g = buildFauxText(THREE, CanvasText, opts("g"));
    const ys = g.children.map((c) => c.position.y);
    for (const y of ys) expect(y).toBeCloseTo(ys[0], 6);
    expect(g.children.length).toBe(3);
  });
});
