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
import { leadFill } from "@/lib/export/export-base";

describe("enableExpr", () => {
  it("passes timing through unshifted with timeOffset 0 (export backend)", () => {
    expect(enableExpr(2, 3, 0)).toBe("gte(t,2)*lt(t,5)");
  });

  it("shifts the enable window to window-local time (seam cache)", () => {
    // Overlay at composition t=4..7, window starts at 4 → local 0..3.
    expect(enableExpr(4, 3, 4)).toBe("gte(t,0)*lt(t,3)");
  });

  it("clamps the lower bound to 0 for an overlay that began before the window", () => {
    // Overlay at composition t=0..10, window starts at 4 → local -4..6 → 0..6.
    expect(enableExpr(0, 10, 4)).toBe("gte(t,0)*lt(t,6)");
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
    expect(spec).toContain("enable='gte(t,1)*lt(t,3)'");
    expect(spec).toContain("text='Hello'");
    expect(spec).toContain("fontsize=48");
    expect(spec).toContain("font='Inter'");
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

  it("names only the first family of a CSS list, unquoted, as a quoted filter value", () => {
    expect(drawtextSpecFor({ ...text, font: "48px Montserrat, sans-serif" }, 0)).toContain(":font='Montserrat':");
    expect(drawtextSpecFor({ ...text, font: "48px 'Playfair Display', serif" }, 0)).toContain(":font='Playfair Display':");
  });

  it("honors a structured fontFamily over the shorthand family", () => {
    const structured: TextOverlayLike = { ...text, font: "48px Inter", fontFamily: "Anton" };
    expect(drawtextSpecFor(structured, 0)).toContain("font='Anton'");
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
    expect(segs[1]).toBe("[vcat][ovl0]overlay=100:200:enable='gte(t,2)*lt(t,6)'[vo0]");
  });

  it("keys the scratch label by scratchKey so multiple overlays don't collide", () => {
    const a = assetOverlaySegments(img, 3, "vcat", "vo0", "0", 0);
    const b = assetOverlaySegments(img, 4, "vo0", "vo1", "1", 0);
    expect(a[0]).toContain("[ovl0]");
    expect(b[0]).toContain("[ovl1]");
  });
});

// docs-local/qa/2026-09-25-mediabunny-upgrade-report.md (Export lead fix).
// Rendered with real ffmpeg in export-source-lead.test.ts.
describe("a video overlay's timing", () => {
  const vid: AssetOverlayLike = {
    kind: "video", startTime: 2, duration: 3, rect: { x: 0, y: 0, width: 64, height: 36 }, opacity: 1, fileId: "v", fit: "cover",
  };
  it("plays its source from its own start: timestamps move to the overlay's window", () => {
    expect(assetOverlaySegments(vid, 1, "b", "o", "0", 0)[0]).toMatch(/^\[1:v\]setpts=PTS\+2\/TB,scale=/);
    // window-local graph (seam cache): the window starts 0.5 s into the overlay
    expect(assetOverlaySegments({ ...vid, startTime: 4 }, 1, "b", "o", "0", 4.5)[0]).toMatch(/^\[1:v\]setpts=PTS-0\.5\/TB,/);
    expect(assetOverlaySegments({ ...vid, startTime: 0 }, 1, "b", "o", "0", 0)[0]).toMatch(/^\[1:v\]scale=/);
  });
  it("shows its first frame over a late-starting video's lead", () => {
    expect(leadFill(0)).toBe("");
    expect(leadFill(0.0004)).toBe("");
    expect(leadFill(0.4)).toBe("setpts=PTS-STARTPTS,tpad=start_mode=clone:start_duration=0.4,");
    expect(assetOverlaySegments(vid, 1, "b", "o", "0", 0, 1, undefined, undefined, 0.4)[0])
      .toMatch(/^\[1:v\]setpts=PTS-STARTPTS,tpad=start_mode=clone:start_duration=0\.4,setpts=PTS\+2\/TB,scale=/);
  });
  it("leaves an image as it was", () => {
    expect(assetOverlaySegments({ ...vid, kind: "image", fit: undefined }, 1, "b", "o", "0", 0)[0]).not.toContain("setpts");
  });
});
