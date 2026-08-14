import { describe, it, expect } from "vitest";
import {
  padBbox,
  clampBboxToFrame,
  translateBboxFromCrop,
} from "@/lib/tracking/face-detection-helpers";

describe("padBbox", () => {
  it("inflates a centered bbox by the given fractional padding", () => {
    // 100x100 box at (50,50). 50% padding → 150x150 at (25,25).
    expect(padBbox({ x: 50, y: 50, w: 100, h: 100 }, 0.5)).toEqual({
      x: 25, y: 25, w: 150, h: 150,
    });
  });

  it("supports zero padding (identity)", () => {
    expect(padBbox({ x: 10, y: 20, w: 30, h: 40 }, 0)).toEqual({
      x: 10, y: 20, w: 30, h: 40,
    });
  });

  it("rounds to integer pixels", () => {
    expect(padBbox({ x: 0, y: 0, w: 9, h: 9 }, 0.5)).toEqual({
      x: -2, y: -2, w: 14, h: 14,
    });
  });
});

describe("clampBboxToFrame", () => {
  it("clamps a bbox that extends past the right and bottom edges", () => {
    expect(clampBboxToFrame({ x: 1800, y: 1000, w: 200, h: 200 }, 1920, 1080)).toEqual({
      x: 1800, y: 1000, w: 120, h: 80,
    });
  });

  it("clamps a bbox with negative x/y by shifting and shrinking", () => {
    expect(clampBboxToFrame({ x: -10, y: -20, w: 100, h: 200 }, 1920, 1080)).toEqual({
      x: 0, y: 0, w: 90, h: 180,
    });
  });

  it("leaves an in-frame bbox unchanged", () => {
    expect(clampBboxToFrame({ x: 100, y: 100, w: 200, h: 200 }, 1920, 1080)).toEqual({
      x: 100, y: 100, w: 200, h: 200,
    });
  });

  it("returns a zero-size bbox for fully off-frame inputs", () => {
    expect(clampBboxToFrame({ x: 2000, y: 0, w: 100, h: 100 }, 1920, 1080)).toEqual({
      x: 1920, y: 0, w: 0, h: 100,
    });
  });
});

describe("translateBboxFromCrop", () => {
  it("translates a bbox detected in a crop back into the original frame's coordinates", () => {
    // crop starts at (300,200), detection at (50,40) inside the crop.
    expect(
      translateBboxFromCrop(
        { x: 50, y: 40, w: 100, h: 120 },
        { x: 300, y: 200 },
      ),
    ).toEqual({ x: 350, y: 240, w: 100, h: 120 });
  });
});
