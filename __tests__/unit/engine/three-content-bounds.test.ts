import { describe, expect, it } from "vitest";

import {
  contentBoundsToRect,
  contentBoundsToRectUnclamped,
  expandRectToContentBounds,
  floorContentRect,
  mapContentRectToViewport,
  unionRect,
} from "@/lib/engine/three-content-bounds";
import type { OverlayRect } from "@/lib/engine/types";

describe("contentBoundsToRect", () => {
  it("maps normalized content bounds within a viewport rect to a composition-space rect", () => {
    expect(
      contentBoundsToRect(
        { x: 100, y: 100, width: 400, height: 400 },
        { minX: 0.25, minY: 0, maxX: 0.75, maxY: 0.2 },
      ),
    ).toEqual({ x: 200, y: 100, width: 200, height: 80 });
  });

  it("returns null for null bounds", () => {
    expect(contentBoundsToRect({ x: 100, y: 100, width: 400, height: 400 }, null)).toBeNull();
  });

  it("returns null for a degenerate box (maxX === minX)", () => {
    expect(
      contentBoundsToRect(
        { x: 100, y: 100, width: 400, height: 400 },
        { minX: 0.5, minY: 0, maxX: 0.5, maxY: 0.5 },
      ),
    ).toBeNull();
  });

  it("clamps out-of-[0,1] inputs to the viewport", () => {
    // minX clamps to 0, maxX clamps to 1, minY clamps to 0, maxY clamps to 1 →
    // full rect.
    expect(
      contentBoundsToRect(
        { x: 100, y: 100, width: 400, height: 400 },
        { minX: -0.5, minY: -2, maxX: 1.5, maxY: 3 },
      ),
    ).toEqual({ x: 100, y: 100, width: 400, height: 400 });
  });
});

describe("floorContentRect", () => {
  const viewport: OverlayRect = { x: 100, y: 100, width: 200, height: 200 };

  it("leaves a content rect already above the minimum untouched", () => {
    const content: OverlayRect = { x: 140, y: 150, width: 120, height: 100 };
    expect(floorContentRect(content, viewport, 64, 64)).toEqual(content);
  });

  it("floors a collapsed (foreshortened) box up to the minimum, centered on the content", () => {
    // The bug case: content projected to a 200×12 sliver inside a 200×200 viewport.
    const content: OverlayRect = { x: 100, y: 194, width: 200, height: 12 };
    const out = floorContentRect(content, viewport, 64, 64);
    expect(out.width).toBe(200); // already full-width, unchanged
    expect(out.height).toBe(64); // floored up from 12
    // centered on the content centroid (y midpoint = 194 + 6 = 200)
    expect(out.y + out.height / 2).toBeCloseTo(200, 5);
  });

  it("allows the box to EXCEED the viewport when content is larger — no viewport clamp", () => {
    // Tilted/extruded 3D content legitimately renders beyond the base rect.
    // The min floors up to minW/minH; content larger than the viewport is kept as-is.
    const tinyViewport: OverlayRect = { x: 0, y: 0, width: 48, height: 12 };
    const content: OverlayRect = { x: 0, y: 0, width: 48, height: 12 };
    const out = floorContentRect(content, tinyViewport, 64, 64);
    // width floored from 48 to 64 (exceeds viewport width of 48 — allowed)
    expect(out.width).toBe(64);
    expect(out.height).toBe(64);
  });

  it("floors a sliver at the bottom edge and allows overflow past the viewport", () => {
    // content hugging the bottom edge; flooring height up may overflow — that's OK now.
    const content: OverlayRect = { x: 120, y: 290, width: 80, height: 8 };
    const out = floorContentRect(content, viewport, 64, 64);
    expect(out.height).toBe(64);
    // centered on content centroid (y midpoint = 290 + 4 = 294)
    expect(out.y + out.height / 2).toBeCloseTo(294, 5);
    // box may now extend below the viewport bottom (300) — no clamp
    expect(out.y + out.height).toBeGreaterThan(viewport.y + viewport.height);
  });

  it("content larger than the viewport is kept at content size (never shrunk)", () => {
    // Extruded/tilted 3D overlay: content footprint is bigger than the base rect.
    const bigContent: OverlayRect = { x: 50, y: 50, width: 400, height: 400 };
    const out = floorContentRect(bigContent, viewport, 64, 64);
    // width/height must be >= content (not capped to viewport)
    expect(out.width).toBeGreaterThanOrEqual(bigContent.width);
    expect(out.height).toBeGreaterThanOrEqual(bigContent.height);
    // centered on content centroid
    expect(out.x + out.width / 2).toBeCloseTo(bigContent.x + bigContent.width / 2, 5);
    expect(out.y + out.height / 2).toBeCloseTo(bigContent.y + bigContent.height / 2, 5);
  });
});

describe("expandRectToContentBounds", () => {
  const rect = { x: 100, y: 100, width: 200, height: 100 };
  it("returns the base rect when content is fully inside [0,1]", () => {
    const r = expandRectToContentBounds(rect, { minX: 0.1, minY: 0.1, maxX: 0.9, maxY: 0.9 }, 4);
    expect(r.expanded).toEqual(rect);
    expect(r.offsetX).toBe(0);
    expect(r.offsetY).toBe(0);
  });
  it("returns the base rect for null bounds", () => {
    const r = expandRectToContentBounds(rect, null, 4);
    expect(r.expanded).toEqual(rect);
    expect(r.offsetX).toBe(0);
  });
  it("grows left/up when content projects past the top-left", () => {
    const r = expandRectToContentBounds(rect, { minX: -0.5, minY: 0, maxX: 1, maxY: 1 }, 4);
    // loX = -0.5 → expanded.x = 100 + (-0.5*200) = 0 ; width = (1 - -0.5)*200 = 300
    expect(r.expanded.x).toBe(0);
    expect(r.expanded.width).toBe(300);
    expect(r.expanded.y).toBe(100);
    expect(r.expanded.height).toBe(100);
    expect(r.offsetX).toBe(100); // base rect sits 100px into the expanded buffer
    expect(r.offsetY).toBe(0);
  });
  it("grows right/down when content projects past the bottom-right", () => {
    const r = expandRectToContentBounds(rect, { minX: 0, minY: 0, maxX: 1.5, maxY: 2 }, 4);
    expect(r.expanded.width).toBe(300);  // (1.5 - 0) * 200
    expect(r.expanded.height).toBe(200); // (2 - 0) * 100
    expect(r.offsetX).toBe(0);
  });
  it("clamps growth to `cap`x the base side", () => {
    const r = expandRectToContentBounds(rect, { minX: -10, minY: 0, maxX: 11, maxY: 1 }, 2);
    expect(r.expanded.width).toBeLessThanOrEqual(rect.width * 2);
  });
});

describe("contentBoundsToRectUnclamped", () => {
  const rect = { x: 0, y: 0, width: 100, height: 100 };
  it("returns null on null bounds", () => {
    expect(contentBoundsToRectUnclamped(rect, null)).toBeNull();
  });
  it("returns a rect that can EXCEED the viewport (unlike the clamped variant)", () => {
    const r = contentBoundsToRectUnclamped(rect, { minX: -0.2, minY: 0, maxX: 1.2, maxY: 1 });
    expect(r).not.toBeNull();
    expect(r!.x).toBeCloseTo(-20);
    expect(r!.width).toBeCloseTo(140);
  });
  it("returns null for a degenerate (sub-2px) box", () => {
    expect(contentBoundsToRectUnclamped(rect, { minX: 0.5, minY: 0.5, maxX: 0.505, maxY: 0.505 })).toBeNull();
  });
});

describe("unionRect", () => {
  it("returns the bounding rect covering both inputs", () => {
    const a = { x: 0, y: 0, width: 100, height: 100 };
    const b = { x: 50, y: -20, width: 100, height: 50 };
    const u = unionRect(a, b);
    expect(u).toEqual({ x: 0, y: -20, width: 150, height: 120 });
  });
});

describe("FIX B: expandRectToContentBounds quantizes expansion to Q=0.125 grid", () => {
  // A rect with width=200, height=100 at origin (0,0).
  const rect: OverlayRect = { x: 0, y: 0, width: 200, height: 100 };

  it("snaps a tiny minX overflow (-0.05) to the next Q boundary (-0.125)", () => {
    // minX=-0.05 → floor(-0.05/0.125)*0.125 = -1*0.125 = -0.125
    // expanded.x = rect.x + loX * rect.width = 0 + (-0.125)*200 = -25
    const { expanded } = expandRectToContentBounds(rect, { minX: -0.05, minY: 0, maxX: 1, maxY: 1 });
    expect(expanded.x).toBeCloseTo(-25, 5);
  });

  it("snaps a tiny maxX overflow (1.05) to the next Q boundary (1.125)", () => {
    // maxX=1.05 → ceil(1.05/0.125)*0.125 = 9*0.125 = 1.125
    // expanded right edge = 0 + 1.125*200 = 225
    const { expanded } = expandRectToContentBounds(rect, { minX: 0, minY: 0, maxX: 1.05, maxY: 1 });
    expect(expanded.x + expanded.width).toBeCloseTo(225, 5);
  });

  it("snaps a tiny maxY overflow (1.03) to Q=1.125, bottom edge = 112.5", () => {
    const { expanded } = expandRectToContentBounds(rect, { minX: 0, minY: 0, maxX: 1, maxY: 1.03 });
    expect(expanded.y + expanded.height).toBeCloseTo(112.5, 5);
  });

  it("values already on a Q boundary are not shifted", () => {
    // ±0.25 are already multiples of 0.125 → no change
    const { expanded } = expandRectToContentBounds(rect, { minX: -0.25, minY: -0.25, maxX: 1.25, maxY: 1.25 });
    expect(expanded.x).toBeCloseTo(-50, 5);
    expect(expanded.y).toBeCloseTo(-25, 5);
    expect(expanded.x + expanded.width).toBeCloseTo(250, 5);
    expect(expanded.y + expanded.height).toBeCloseTo(125, 5);
  });
});

describe("mapContentRectToViewport", () => {
  const viewport: OverlayRect = { x: 50, y: 50, width: 400, height: 400 };
  // content sits inside the viewport at a fixed offset/scale.
  const content: OverlayRect = { x: 150, y: 100, width: 200, height: 80 };

  it("returns the viewport unchanged when d === c (identity)", () => {
    expect(mapContentRectToViewport(content, content, viewport)).toEqual(viewport);
  });

  it("shifts the viewport by the same delta on a pure move", () => {
    const moved: OverlayRect = { ...content, x: content.x + 30, y: content.y - 20 };
    expect(mapContentRectToViewport(moved, content, viewport)).toEqual({
      x: viewport.x + 30,
      y: viewport.y - 20,
      width: viewport.width,
      height: viewport.height,
    });
  });

  it("scales the viewport 2× on a uniform 2× resize of the content", () => {
    // anchor the resize at the content origin (top-left fixed) so offsets stay clean.
    const resized: OverlayRect = {
      x: content.x,
      y: content.y,
      width: content.width * 2,
      height: content.height * 2,
    };
    expect(mapContentRectToViewport(resized, content, viewport)).toEqual({
      // offX = (50 - 150) * 2 = -200 → x = 150 + (-200) = -50
      x: content.x + (viewport.x - content.x) * 2,
      y: content.y + (viewport.y - content.y) * 2,
      width: viewport.width * 2,
      height: viewport.height * 2,
    });
  });
});
