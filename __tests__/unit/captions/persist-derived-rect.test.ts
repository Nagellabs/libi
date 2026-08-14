import { describe, it, expect } from "vitest";
import { recomputeTextOverlayRect } from "@/lib/captions/persist-rect";

// Approximate server measurer: chars * fontSizePx * 0.5 — matches the one used
// in saveManifest. Deterministic so the recomputed rect is assertable.
const measureFor = (fontSizePx: number) => (s: string) => s.length * fontSizePx * 0.5;

describe("recomputeTextOverlayRect", () => {
  it("centers horizontally on x and bottom-anchors on y", () => {
    const overlay = {
      id: "o1",
      kind: "text" as const,
      startTime: 0,
      duration: 2,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      z: 0,
      opacity: 1,
      content: "Hello",
      font: "48px sans-serif",
      color: "#fff",
      align: "center" as const,
      anchor: "bottom-center" as const,
      position: { x: 960, y: 1040 },
      fontSize: 64,
    };
    const measure = measureFor(64);
    const rect = recomputeTextOverlayRect(overlay, 1920, measure);

    // width = measure("Hello") = 5 * 64 * 0.5 = 160
    const width = measure("Hello");
    // height = 1 line * 64 * 1.2 = 76.8
    const height = 64 * 1.2;
    expect(rect.width).toBeCloseTo(width, 5);
    expect(rect.height).toBeCloseTo(height, 5);
    // bottom-center: x = 960 - width/2, y = 1040 - height
    expect(rect.x).toBeCloseTo(960 - width / 2, 5);
    expect(rect.y).toBeCloseTo(1040 - height, 5);
  });

  it("leaves rect untouched when anchor or position missing", () => {
    const base = {
      id: "o2",
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
      // no anchor / no position
    };
    const measure = measureFor(48);
    const rect = recomputeTextOverlayRect(base, 1920, measure);
    expect(rect).toEqual({ x: 100, y: 200, width: 800, height: 120 });
  });
});
