import { describe, it, expect } from "vitest";
import { hitTest } from "@/lib/engine/overlays";
import type { TextOverlay } from "@/lib/engine/types";

function mk(id: string, x: number, y: number, w: number, h: number, z = 0): TextOverlay {
  return {
    id, kind: "text", content: "", font: "", color: "", align: "left", opacity: 1,
    rect: { x, y, width: w, height: h }, startTime: 0, duration: 10, z,
  };
}

describe("hitTest", () => {
  it("returns the overlay rect containing the click", () => {
    const overlays = [mk("a", 0, 0, 100, 100)];
    expect(hitTest(50, 50, overlays, 1)?.id).toBe("a");
  });

  it("returns null when no overlay contains the click", () => {
    const overlays = [mk("a", 0, 0, 10, 10)];
    expect(hitTest(50, 50, overlays, 1)).toBe(null);
  });

  it("returns the top overlay (highest z) when multiple overlap", () => {
    const overlays = [
      mk("bottom", 0, 0, 100, 100, 0),
      mk("top", 0, 0, 100, 100, 5),
      mk("mid", 0, 0, 100, 100, 2),
    ];
    expect(hitTest(50, 50, overlays, 1)?.id).toBe("top");
  });

  it("ignores overlays not active at the given time", () => {
    const overlays = [
      { ...mk("a", 0, 0, 100, 100), startTime: 5, duration: 1 },
      mk("b", 0, 0, 100, 100),
    ];
    expect(hitTest(50, 50, overlays, 1)?.id).toBe("b");
  });
});
