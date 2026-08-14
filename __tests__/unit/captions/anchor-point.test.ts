import { describe, it, expect } from "vitest";
import { anchorPointOf, placeBoxAtAnchor } from "@/lib/captions/anchor";
import type { CaptionAnchor } from "@/lib/captions/types";

describe("anchorPointOf (inverse of placeBoxAtAnchor)", () => {
  const rect = { x: 120, y: 240, width: 360, height: 80 };
  const anchors: CaptionAnchor[] = [
    "top-left",
    "top-center",
    "top-right",
    "mid-center",
    "bottom-center",
    "bottom-right",
  ];

  it("round-trips: placeBoxAtAnchor(anchorPointOf(rect, a), a, w, h) === rect", () => {
    for (const a of anchors) {
      const point = anchorPointOf(rect, a);
      const back = placeBoxAtAnchor(point, a, rect.width, rect.height);
      expect(back).toEqual(rect);
    }
  });

  it("computes the expected point for known anchors", () => {
    expect(anchorPointOf(rect, "top-left")).toEqual({ x: 120, y: 240 });
    expect(anchorPointOf(rect, "mid-center")).toEqual({ x: 300, y: 280 });
    expect(anchorPointOf(rect, "bottom-right")).toEqual({ x: 480, y: 320 });
  });
});
