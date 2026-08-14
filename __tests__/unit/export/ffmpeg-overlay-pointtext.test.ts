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
 *   - the text block's TOP sits at `rect.y` (renderer uses `textBaseline:"top"`;
 *     drawtext uses `y = rect.y`).
 *
 * This pins that behavior as a regression guard — the export already positions
 * correctly off the derived rect + align, so this is a characterization test.
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

  it("places the text block top at the rect's top edge (y = rect.y)", () => {
    const spec = drawtextSpecFor(caption, 0);
    expect(spec).toContain("y=920");
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
