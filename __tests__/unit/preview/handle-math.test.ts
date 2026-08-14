import { describe, it, expect } from "vitest";
import { scaleFontFromCornerDrag } from "@/components/preview/overlay-handles";

describe("scaleFontFromCornerDrag", () => {
  it("doubles fontSize when the diagonal doubles", () => {
    expect(scaleFontFromCornerDrag(48, 100, 200)).toBe(96);
  });

  it("halves fontSize when the diagonal halves", () => {
    expect(scaleFontFromCornerDrag(48, 100, 50)).toBe(24);
  });

  it("is identity when the diagonal is unchanged", () => {
    expect(scaleFontFromCornerDrag(48, 100, 100)).toBe(48);
  });

  it("clamps to a sane minimum, never zero or negative", () => {
    const out = scaleFontFromCornerDrag(48, 100, 1);
    expect(out).toBeGreaterThanOrEqual(4);
  });

  it("never returns negative even for a degenerate new diagonal", () => {
    const out = scaleFontFromCornerDrag(48, 100, 0);
    expect(out).toBeGreaterThanOrEqual(4);
  });
});
