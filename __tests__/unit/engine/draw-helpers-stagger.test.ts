import { describe, it, expect } from "vitest";
import { stagger } from "@/lib/engine/animation";
import { DRAW_HELPERS } from "@/lib/engine/draw-helpers";

describe("stagger", () => {
  it("returns 0 before an item's slice and 1 after", () => {
    // 4 items, no overlap, global progress 0 → item 0 just starting, item 3 at 0
    expect(stagger(0, 0, 4, 0)).toBe(0);
    expect(stagger(0, 3, 4, 0)).toBe(0);
    // global progress 1 → every item fully revealed
    expect(stagger(1, 0, 4, 0)).toBe(1);
    expect(stagger(1, 3, 4, 0)).toBe(1);
  });

  it("item 0 leads item 3 at a mid progress", () => {
    const a = stagger(0.5, 0, 4, 0);
    const b = stagger(0.5, 3, 4, 0);
    expect(a).toBeGreaterThan(b);
  });

  it("is exposed in DRAW_HELPERS", () => {
    expect(typeof DRAW_HELPERS.stagger).toBe("function");
  });
});
