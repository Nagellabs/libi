import { describe, it, expect } from "vitest";
import { screenToCompositionPoint } from "@/components/preview/reanchor-drag-math";

describe("screenToCompositionPoint", () => {
  it("maps a client point to composition px via the display rect", () => {
    const p = screenToCompositionPoint(
      { clientX: 100, clientY: 50 },
      { left: 0, top: 0, width: 960, height: 540 } as DOMRect,
      1920, 1080,
    );
    expect(p).toEqual({ x: 200, y: 100 });
  });
});
