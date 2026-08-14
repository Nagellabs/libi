import { describe, it, expect } from "vitest";
import { anchorFraction, placeBoxAtAnchor } from "@/lib/captions/anchor";

describe("anchorFraction", () => {
  it("maps the 9 anchors to (fx, fy) fractions", () => {
    expect(anchorFraction("top-left")).toEqual({ fx: 0, fy: 0 });
    expect(anchorFraction("top-center")).toEqual({ fx: 0.5, fy: 0 });
    expect(anchorFraction("top-right")).toEqual({ fx: 1, fy: 0 });
    expect(anchorFraction("mid-left")).toEqual({ fx: 0, fy: 0.5 });
    expect(anchorFraction("mid-center")).toEqual({ fx: 0.5, fy: 0.5 });
    expect(anchorFraction("mid-right")).toEqual({ fx: 1, fy: 0.5 });
    expect(anchorFraction("bottom-left")).toEqual({ fx: 0, fy: 1 });
    expect(anchorFraction("bottom-center")).toEqual({ fx: 0.5, fy: 1 });
    expect(anchorFraction("bottom-right")).toEqual({ fx: 1, fy: 1 });
  });
});

describe("placeBoxAtAnchor", () => {
  it("places a 400x80 box so its anchor sits at the position", () => {
    expect(placeBoxAtAnchor({ x: 960, y: 1000 }, "bottom-center", 400, 80)).toEqual({
      x: 760,
      y: 920,
      width: 400,
      height: 80,
    });
    expect(placeBoxAtAnchor({ x: 960, y: 1000 }, "top-center", 400, 80)).toEqual({
      x: 760,
      y: 1000,
      width: 400,
      height: 80,
    });
    expect(placeBoxAtAnchor({ x: 960, y: 1000 }, "top-left", 400, 80)).toEqual({
      x: 960,
      y: 1000,
      width: 400,
      height: 80,
    });
    expect(placeBoxAtAnchor({ x: 960, y: 1000 }, "mid-center", 400, 80)).toEqual({
      x: 760,
      y: 960,
      width: 400,
      height: 80,
    });
  });
});
