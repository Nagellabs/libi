import { describe, it, expect } from "vitest";
import { drawtextSpecFor, type TextOverlayLike } from "@/lib/export/overlay-filter";

const overlay: TextOverlayLike = {
  kind: "text",
  startTime: 0,
  duration: 1,
  rect: { x: 0, y: 0, width: 100, height: 50 },
  content: "Hi",
  font: "48px Inter",
  color: "#ffffff",
  align: "left",
};

describe("drawtext fontfile", () => {
  it("emits fontfile= when a font file path is supplied", () => {
    const spec = drawtextSpecFor(overlay, 0, "/abs/path/MyFont.ttf");
    expect(spec).toContain("fontfile=/abs/path/MyFont.ttf");
    // family name not used when a file is given
    expect(spec).not.toMatch(/(^|:)font=/);
  });

  it("escapes a colon in the font file path", () => {
    const spec = drawtextSpecFor(overlay, 0, "/abs/Weird:Path/MyFont.ttf");
    expect(spec).toContain("fontfile=/abs/Weird\\:Path/MyFont.ttf");
  });

  it("falls back to font=<family> when no file path is supplied", () => {
    const spec = drawtextSpecFor(overlay, 0, undefined);
    expect(spec).toContain("font=Inter");
    expect(spec).not.toContain("fontfile=");
  });
});
