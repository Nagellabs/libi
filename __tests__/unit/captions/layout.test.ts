import { describe, it, expect } from "vitest";
import { layoutTextOverlay } from "@/lib/captions/layout";

// Deterministic measure: 10px per char.
const measure = (s: string) => s.length * 10;

describe("layoutTextOverlay", () => {
  it("no wrap: box hugs the text and pins the anchor", () => {
    const { rect, lines } = layoutTextOverlay(
      {
        content: "AB",
        position: { x: 500, y: 500 },
        anchor: "bottom-center",
        fontSizePx: 20,
        lineHeight: 1.2,
        frameWidth: 1000,
        padding: 0,
      },
      measure,
    );
    expect(lines).toEqual(["AB"]);
    // width = measure("AB") = 20, height = 1 line * 20 * 1.2 = 24
    expect(rect).toEqual({ x: 490, y: 476, width: 20, height: 24 });
  });

  it("wraps to maxWidthPct of frame width", () => {
    const longWord = "x".repeat(80); // measure = 800 > 500 wrapWidth
    const content = `${"a".repeat(40)} ${"b".repeat(40)}`; // each = 400, both ≤ 500 alone
    const { rect, lines } = layoutTextOverlay(
      {
        content,
        position: { x: 0, y: 0 },
        anchor: "top-left",
        fontSizePx: 20,
        lineHeight: 1.2,
        maxWidthPct: 0.5, // wrapWidth = 500
        frameWidth: 1000,
        padding: 0,
      },
      measure,
    );
    expect(lines.length).toBeGreaterThan(1);
    expect(rect.width).toBeLessThanOrEqual(500);
    void longWord;
  });

  it("single short word: box width equals measured word width", () => {
    const { rect, lines } = layoutTextOverlay(
      {
        content: "Hi",
        position: { x: 0, y: 0 },
        anchor: "top-left",
        fontSizePx: 20,
        lineHeight: 1.2,
        frameWidth: 1000,
        padding: 0,
      },
      measure,
    );
    expect(lines).toEqual(["Hi"]);
    expect(rect.width).toBe(measure("Hi"));
    expect(rect.width).toBe(20);
  });
});
