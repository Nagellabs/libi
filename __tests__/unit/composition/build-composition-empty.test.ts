import { describe, it, expect } from "vitest";
import { buildComposition } from "@/lib/composition/build-composition";
import type { Overlay } from "@/lib/engine/types";

/**
 * Empty-scenes path: a video-less piece must hydrate into a valid
 * Composition with scenes:[] (default-black background) + its overlays,
 * NOT null. The overlay loop renders independently of scenes.
 */
describe("buildComposition with empty scenes", () => {
  const oneOverlay: Overlay = {
    id: "t1",
    kind: "text",
    content: "hi",
    font: "24px Inter",
    color: "#fff",
    align: "left",
    opacity: 1,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    startTime: 0,
    duration: 1,
    z: 0,
  } as unknown as Overlay;

  it("returns a valid empty composition with default-black background and the overlay", () => {
    const comp = buildComposition([], new Map(), [oneOverlay]);
    expect(comp).not.toBeNull();
    expect(comp!.scenes).toEqual([]);
    expect(comp!.backgroundColor).toBe("#000000");
    expect(comp!.overlays).toHaveLength(1);
    expect(comp!.overlays![0].id).toBe("t1");
  });

  it("returns a valid empty composition even with no overlays", () => {
    const comp = buildComposition([], new Map(), []);
    expect(comp).not.toBeNull();
    expect(comp!.scenes).toEqual([]);
    expect(comp!.backgroundColor).toBe("#000000");
  });
});
