import { describe, it, expect } from "vitest";
import { overlaysActiveAt, hitTest } from "@/lib/engine/overlays";
import type { Overlay } from "@/lib/engine/types";

/**
 * Layer A of the persisted eye toggle: `overlaysActiveAt` is the single
 * chokepoint every render surface goes through (renderFrame,
 * collectVideoSeekTargets, hitTest, the chromium /render page, canvas-source
 * exportVideo) — skipping `hidden: true` here makes a hidden layer unpainted
 * and un-hit-testable EVERYWHERE by construction.
 */

function textOverlay(over: Record<string, unknown> = {}): Overlay {
  return {
    id: "t1", kind: "text", z: 1, startTime: 0, duration: 10,
    rect: { x: 0, y: 0, width: 200, height: 100 }, text: "hi", opacity: 1,
    ...over,
  } as unknown as Overlay;
}

describe("overlaysActiveAt — hidden overlays are skipped (Layer A)", () => {
  it("excludes hidden overlays from the active set", () => {
    const overlays = [
      textOverlay({ id: "visible" }),
      textOverlay({ id: "hidden-one", hidden: true }),
      textOverlay({ id: "hidden-false", hidden: false }),
    ];
    const active = overlaysActiveAt(overlays, 1);
    expect(active.map((o) => o.id)).toEqual(["visible", "hidden-false"]);
  });

  it("hidden overlays are not canvas-hit-testable", () => {
    const overlays = [textOverlay({ id: "h", hidden: true })];
    expect(hitTest(50, 50, overlays, 1)).toBeNull();
  });
});
