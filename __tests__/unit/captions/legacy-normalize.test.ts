import { describe, it, expect } from "vitest";
import { normalizeLegacyTextOverlay } from "@/lib/captions/legacy-normalize";

// Approximate server measurer: chars * fontSizePx * 0.5.
const measureFor = (fontSizePx: number) => (s: string) => s.length * fontSizePx * 0.5;

describe("normalizeLegacyTextOverlay", () => {
  it("normalizes a short-content legacy rect to point text (mid-center, no wrap)", () => {
    const legacy = {
      id: "o1",
      kind: "text" as const,
      startTime: 0,
      duration: 2,
      rect: { x: 100, y: 200, width: 800, height: 120 },
      z: 0,
      opacity: 1,
      content: "Hi",
      font: "48px sans-serif",
      color: "#fff",
      align: "center" as const,
      fontSize: 48,
    };
    const out = normalizeLegacyTextOverlay(legacy, 1920, measureFor(48));
    expect(out.anchor).toBe("mid-center");
    // rect center: x = 100 + 800/2 = 500, y = 200 + 120/2 = 260
    expect(out.position).toEqual({ x: 500, y: 260 });
    // content "Hi" measure = 2 * 48 * 0.5 = 48 < rect.width 800 ⇒ single line.
    expect(out.maxWidthPct).toBeUndefined();
    // fontSize untouched
    expect(out.fontSize).toBe(48);
  });

  it("sets maxWidthPct when legacy content was wider than the authored rect", () => {
    const wide = "w".repeat(60); // measure at 48px = 60 * 48 * 0.5 = 1440 > 800
    const legacy = {
      id: "o2",
      kind: "text" as const,
      startTime: 0,
      duration: 2,
      rect: { x: 100, y: 200, width: 800, height: 120 },
      z: 0,
      opacity: 1,
      content: wide,
      font: "48px sans-serif",
      color: "#fff",
      align: "center" as const,
      fontSize: 48,
    };
    const out = normalizeLegacyTextOverlay(legacy, 1920, measureFor(48));
    expect(out.anchor).toBe("mid-center");
    expect(out.maxWidthPct).toBeCloseTo(800 / 1920, 5);
  });

  it("is idempotent: an overlay that already has anchor is unchanged", () => {
    const already = {
      id: "o3",
      kind: "text" as const,
      startTime: 0,
      duration: 2,
      rect: { x: 100, y: 200, width: 800, height: 120 },
      z: 0,
      opacity: 1,
      content: "Hi",
      font: "48px sans-serif",
      color: "#fff",
      align: "center" as const,
      fontSize: 48,
      anchor: "top-center" as const,
      position: { x: 500, y: 200 },
    };
    const out = normalizeLegacyTextOverlay(already, 1920, measureFor(48));
    expect(out).toBe(already);
  });
});
