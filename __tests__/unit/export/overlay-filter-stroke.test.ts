/**
 * Regression coverage for QA bug B2
 * (docs-local/qa/2026-09-18-export-quality-split-qa.md): the ffmpeg-overlay
 * (drawtext) export path silently dropped `TextOverlay.stroke`, so a 4K
 * export of a captioned piece with a black outline shipped plain white text
 * while the canvas preview showed the outline.
 */
import { describe, it, expect } from "vitest";
import { drawtextSpecFor, type TextOverlayLike } from "@/lib/export/overlay-filter";

describe("drawtextSpecFor — stroke", () => {
  const base: TextOverlayLike = {
    kind: "text",
    startTime: 0,
    duration: 2,
    rect: { x: 10, y: 20, width: 100, height: 30 },
    content: "Hello",
    font: "48px Inter",
    color: "#ffffff",
    align: "center",
  };

  // The canvas strokes CENTRED on the glyph edge and then fills over it, so
  // only width/2 shows outside the glyph. freetype's border is drawn entirely
  // outside, so borderw = width/2 is what matches (QA 2026-09-18 N3: 1:1 read
  // about twice as thick as the preview).
  it("emits HALF the stroke width as borderw at 1x scale", () => {
    const spec = drawtextSpecFor(
      { ...base, stroke: { color: "#000000", width: 4 } },
      0,
    );
    expect(spec).toContain("borderw=2");
    expect(spec).toContain("bordercolor=#000000");
  });

  it("scales borderw by the same composition→target factor as fontsize", () => {
    const spec = drawtextSpecFor(
      { ...base, stroke: { color: "#000000", width: 4 } },
      0,
      undefined,
      2,
    );
    expect(spec).toContain("borderw=4");
  });

  it("rounds a scaled sub-pixel width up to at least 1", () => {
    const spec = drawtextSpecFor(
      { ...base, stroke: { color: "#000000", width: 1 } },
      0,
      undefined,
      0.25, // 1 * 0.25 = 0.25 → would round to 0
    );
    expect(spec).toContain("borderw=1");
  });

  it("the QA case: stroke 6 → borderw 3 at 1080, 6 at 4K", () => {
    const stroked = { ...base, stroke: { color: "#000", width: 6 } };
    expect(drawtextSpecFor(stroked, 0)).toMatch(/:borderw=3:/);
    expect(drawtextSpecFor(stroked, 0, undefined, 2)).toMatch(/:borderw=6:/);
  });

  it("omits borderw/bordercolor when no stroke is set", () => {
    const spec = drawtextSpecFor(base, 0);
    expect(spec).not.toContain("borderw");
    expect(spec).not.toContain("bordercolor");
  });

  it("omits borderw/bordercolor when stroke width is 0", () => {
    const spec = drawtextSpecFor(
      { ...base, stroke: { color: "#000000", width: 0 } },
      0,
    );
    expect(spec).not.toContain("borderw");
    expect(spec).not.toContain("bordercolor");
  });

  it("converts the stroke color the same way fontcolor is converted", () => {
    const spec = drawtextSpecFor(
      { ...base, stroke: { color: "rgba(0, 0, 0, 0.5)", width: 2 } },
      0,
    );
    expect(spec).toContain("bordercolor=#00000080");
  });
});
