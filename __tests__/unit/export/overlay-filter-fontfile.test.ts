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
    expect(spec).toContain("fontfile='/abs/path/MyFont.ttf'");
    // family name not used when a file is given
    expect(spec).not.toMatch(/(^|:)font=/);
  });

  // A filter option value is read by TWO parsers: the filtergraph parser
  // strips one level of quoting, then the option parser splits on ':' and
  // strips one level of backslash escaping. The old one-level `\:` escape was
  // eaten by the first parser, so the colon split the option — every Windows
  // path (`C:\...`) failed the whole export (review of 640e4a59). The value is
  // now escaped for the option parser and quoted for the graph parser.
  it("escapes a colon in the font file path for both filter parsers", () => {
    const spec = drawtextSpecFor(overlay, 0, "/abs/Weird:Path/MyFont.ttf");
    expect(spec).toContain("fontfile='/abs/Weird\\:Path/MyFont.ttf'");
  });

  it("escapes a Windows path with a drive colon, backslashes and an apostrophe", () => {
    const spec = drawtextSpecFor(overlay, 0, "C:\\Users\\O'Brien\\f.ttf");
    expect(spec).toContain("fontfile='C\\:\\\\Users\\\\O\\'\\''Brien\\\\f.ttf'");
  });

  it("falls back to font=<family> when no file path is supplied", () => {
    const spec = drawtextSpecFor(overlay, 0, undefined);
    expect(spec).toContain("font='Inter'");
    expect(spec).not.toContain("fontfile=");
  });
});
