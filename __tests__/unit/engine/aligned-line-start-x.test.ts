import { describe, it, expect } from "vitest";
import { alignedLineStartX } from "@/lib/engine/overlay-renderer";

/**
 * When painting a caption word-by-word with `textAlign:"left"` (fade-words /
 * karaoke), the start x must back off from the align ANCHOR to the line's true
 * LEFT edge — otherwise center/right captions paint from the anchor and overflow
 * to the right (the fade-words bug).
 */
describe("alignedLineStartX", () => {
  const lineWidth = 500;

  it("left-aligned: anchor IS the left edge", () => {
    expect(alignedLineStartX(100, lineWidth, "left")).toBe(100);
  });

  it("center-aligned: backs off half the line width", () => {
    // anchor (center x) 600 → left edge 600 - 250 = 350
    expect(alignedLineStartX(600, lineWidth, "center")).toBe(350);
  });

  it("right-aligned: backs off the full line width", () => {
    // anchor (right x) 600 → left edge 600 - 500 = 100
    expect(alignedLineStartX(600, lineWidth, "right")).toBe(100);
  });
});
