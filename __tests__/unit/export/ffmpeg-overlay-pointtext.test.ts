/**
 * Task 7.1 — ffmpeg drawtext positions a caption from its derived rect + anchor.
 *
 * Post-M3 the persisted `rect` of a point-text overlay is the MEASURED text box
 * (recomputeTextOverlayRect → placeBoxAtAnchor). The ffmpeg export must place
 * the drawtext consistently with the PREVIEW renderer (`drawTextOverlay`):
 *
 *   - center align: renderer uses `lineX = rect.x + rect.width/2` with
 *     `textAlign:"center"` → text centered on the rect's horizontal middle.
 *     drawtext mirrors this with `x = rect.x + (rect.width - text_w)/2`.
 *   - vertically, the renderer CENTRES the text block (lines × fontSize ×
 *     lineHeight) in the rect and draws each line with `textBaseline:"top"`,
 *     which in Chromium is the top of the em box: the baseline sits
 *     fontSize × ascent/(ascent+descent) below it. drawtext mirrors that with
 *     `y_align=baseline` and the font's own `font_a`/`font_d`. It used to emit
 *     `y = rect.y`, which top-aligned the text in its rect (QA 2026-09-18 N3).
 */
import { describe, it, expect } from "vitest";
import {
  drawtextSpecFor,
  xExprForAlign,
  type TextOverlayLike,
} from "@/lib/export/overlay-filter";

// A center-aligned caption whose DERIVED rect (from a top-center point-text
// placement, recomputed on save) is the measured text box.
const caption: TextOverlayLike = {
  kind: "text",
  startTime: 0,
  duration: 2,
  rect: { x: 760, y: 920, width: 400, height: 80 },
  content: "Hello",
  font: "48px Inter",
  color: "#ffffff",
  align: "center",
};

describe("ffmpeg drawtext — point-text positioning", () => {
  it("centers x within the derived rect (rect.x + (rect.width - text_w)/2)", () => {
    const spec = drawtextSpecFor(caption, 0);
    // rect-centered x — consistent with the renderer's lineX = rect.x + rect.width/2.
    expect(spec).toContain("x=760+(400-text_w)/2");
  });

  it("centres the block in the rect and places the baseline an em-ascent below its top", () => {
    const spec = drawtextSpecFor(caption, 0);
    // block = 1 line × 48 × 1.2 = 57.6; (80 − 57.6)/2 = 11.2 → top 931.2 → 931
    expect(spec).toContain("y_align=baseline");
    expect(spec).toContain("y=931+48*font_a/(font_a+abs(font_d))");
  });

  it("scales the block top and the fontsize together", () => {
    const spec = drawtextSpecFor(caption, 0, undefined, 2);
    expect(spec).toContain("y=1862+96*font_a/(font_a+abs(font_d))");
  });

  it("honours lineHeight and the line count like the renderer", () => {
    const spec = drawtextSpecFor({ ...caption, content: "a\nb", lineHeight: 1 }, 0);
    // block = 2 × 48 × 1 = 96 > 80 → overflow starts at the top (clamped at 0)
    expect(spec).toContain("y=920+48*font_a/(font_a+abs(font_d))");
  });

  // drawtext's own line pitch is the face's line height (145px for 120px
  // Inter-Bold), not lineHeight × fontSize, so a multi-line caption drifted
  // from the preview line by line, and centre/right alignment used the
  // WIDEST line's text_w for every line. Each line is its own drawtext now,
  // at the renderer's line top and aligned on its own width (review MINOR 2).
  it("draws each line as its own drawtext at the renderer's line pitch", () => {
    const spec = drawtextSpecFor(
      { ...caption, rect: { x: 760, y: 920, width: 400, height: 200 }, content: "a\nbb", lineHeight: 1.5 },
      0,
    );
    // block = 2 × 48 × 1.5 = 144; (200 − 144)/2 = 28 → tops 948, 1020
    const parts = spec.split(",drawtext=");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^drawtext=text='a':/);
    expect(parts[0]).toContain("y=948+48*font_a/(font_a+abs(font_d))");
    expect(parts[1]).toMatch(/^text='bb':/);
    expect(parts[1]).toContain("y=1020+48*font_a/(font_a+abs(font_d))");
    expect(parts[1]).toContain("x=760+(400-text_w)/2");
  });

  it("skips an empty line but keeps its slot in the block", () => {
    const spec = drawtextSpecFor(
      { ...caption, rect: { x: 0, y: 0, width: 400, height: 10 }, content: "a\n\nb", lineHeight: 1 },
      0,
    );
    const parts = spec.split(",drawtext=");
    expect(parts).toHaveLength(2);
    expect(parts[1]).toContain("y=96+48*font_a/(font_a+abs(font_d))");
  });

  it("the QA case: 120px in a 300px rect sits 78px down, not at the top", () => {
    const spec = drawtextSpecFor(
      { ...caption, rect: { x: 90, y: 800, width: 900, height: 300 }, fontSize: 120 },
      0,
    );
    // (300 − 144)/2 = 78
    expect(spec).toContain("y=878+120*font_a/(font_a+abs(font_d))");
  });

  it("left align pins x to rect.x", () => {
    expect(xExprForAlign("left", 760, 400)).toBe("760");
  });

  it("right align pins the text's right edge to the rect's right edge", () => {
    expect(xExprForAlign("right", 760, 400)).toBe("760+400-text_w");
  });

  it("center align x-expr centers within the rect", () => {
    expect(xExprForAlign("center", 760, 400)).toBe("760+(400-text_w)/2");
  });
});
