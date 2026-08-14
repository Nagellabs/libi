/**
 * Unit tests for the shared overlay-filter primitives factored out of the
 * FfmpegOverlayBackend so the export backend and the Tier-2 seam render-cache
 * composite overlays identically.
 *
 * The export backend already has exhaustive byte-for-byte coverage in
 * `ffmpeg-overlay-filter-chain.test.ts` (which exercises these emitters with
 * timeOffset 0). These tests focus on the SEAM-specific contract the export
 * tests don't reach: the window-local time shift (`timeOffset = windowStart`)
 * and clamping of the enable window to the base label's t=0 origin.
 */
import { describe, it, expect } from "vitest";
import {
  enableExpr,
  drawtextSpecFor,
  assetOverlaySegments,
  type TextOverlayLike,
  type AssetOverlayLike,
} from "@/lib/export/overlay-filter";

describe("enableExpr", () => {
  it("passes timing through unshifted with timeOffset 0 (export backend)", () => {
    expect(enableExpr(2, 3, 0)).toBe("between(t,2,5)");
  });

  it("shifts the enable window to window-local time (seam cache)", () => {
    // Overlay at composition t=4..7, window starts at 4 → local 0..3.
    expect(enableExpr(4, 3, 4)).toBe("between(t,0,3)");
  });

  it("clamps the lower bound to 0 for an overlay that began before the window", () => {
    // Overlay at composition t=0..10, window starts at 4 → local -4..6 → 0..6.
    expect(enableExpr(0, 10, 4)).toBe("between(t,0,6)");
  });
});

describe("drawtextSpecFor", () => {
  const text: TextOverlayLike = {
    kind: "text",
    startTime: 5,
    duration: 2,
    rect: { x: 10, y: 20, width: 100, height: 30 },
    opacity: 0.8,
    content: "Hello",
    font: "48px Inter",
    color: "#ffffff",
    align: "center",
  };

  it("emits a window-local enable window for the seam cache", () => {
    const spec = drawtextSpecFor(text, 4); // window starts at 4
    expect(spec).toContain("enable='between(t,1,3)'");
    expect(spec).toContain("text='Hello'");
    expect(spec).toContain("fontsize=48");
    expect(spec).toContain("font=Inter");
    expect(spec).toContain("alpha=0.8");
    // center alignment x-expr
    expect(spec).toContain("x=10+(100-text_w)/2");
  });

  it("defaults alpha to 1 when opacity is absent", () => {
    const noOpacity: TextOverlayLike = { ...text, opacity: undefined };
    expect(drawtextSpecFor(noOpacity, 0)).toContain("alpha=1");
  });

  // Regression: the structured `fontSize` field is what the canvas renderer
  // sizes from (`overlay.fontSize ?? parseFontSizePx(composeFont(overlay))`),
  // while `font` keeps whatever shorthand the overlay was created with.
  // drawtext used to read `font` alone, so a 28px caption exported at 48px and
  // its text overflowed the rect and was clipped — preview and export disagreed.
  it("sizes from the structured fontSize, not the stale font shorthand", () => {
    const structured: TextOverlayLike = { ...text, font: "48px Inter", fontSize: 28 };
    expect(drawtextSpecFor(structured, 0)).toContain("fontsize=28");
  });

  it("honors a structured fontFamily over the shorthand family", () => {
    const structured: TextOverlayLike = { ...text, font: "48px Inter", fontFamily: "Anton" };
    expect(drawtextSpecFor(structured, 0)).toContain("font=Anton");
  });

  it("keeps the shorthand size when no structured fields are set", () => {
    expect(drawtextSpecFor(text, 0)).toContain("fontsize=48");
  });

  it("scales the structured fontSize by the composition→target scale", () => {
    const structured: TextOverlayLike = { ...text, font: "48px Inter", fontSize: 28 };
    expect(drawtextSpecFor(structured, 0, undefined, 2)).toContain("fontsize=56");
  });

  it("survives a fractional fontSize (composeFont emits '28.5px')", () => {
    const structured: TextOverlayLike = { ...text, font: "48px Inter", fontSize: 28.5 };
    expect(drawtextSpecFor(structured, 0)).toContain("fontsize=29");
  });
});

describe("assetOverlaySegments", () => {
  const img: AssetOverlayLike = {
    kind: "image",
    startTime: 6,
    duration: 4,
    rect: { x: 100, y: 200, width: 320, height: 240 },
    opacity: 1,
    fileId: "f1",
  };

  it("scales the input to its rect then overlays it with a window-local enable", () => {
    const segs = assetOverlaySegments(img, 3, "vcat", "vo0", "0", 4); // window starts at 4
    expect(segs).toHaveLength(2);
    expect(segs[0]).toBe(
      "[3:v]scale=320:240:force_original_aspect_ratio=decrease[ovl0]",
    );
    expect(segs[1]).toBe("[vcat][ovl0]overlay=100:200:enable='between(t,2,6)'[vo0]");
  });

  it("keys the scratch label by scratchKey so multiple overlays don't collide", () => {
    const a = assetOverlaySegments(img, 3, "vcat", "vo0", "0", 0);
    const b = assetOverlaySegments(img, 4, "vo0", "vo1", "1", 0);
    expect(a[0]).toContain("[ovl0]");
    expect(b[0]).toContain("[ovl1]");
  });
});
