import { describe, it, expect } from "vitest";
import { getCompositionFrames, getTotalFrames } from "@/lib/engine/renderer";
import type { Composition, Overlay, AudioClip } from "@/lib/engine/types";

function comp(partial: Partial<Composition>): Composition {
  return { fps: 30, width: 1920, height: 1080, scenes: [], overlays: [], audioClips: [], ...partial } as Composition;
}
const scene = (id: string, duration: number) =>
  ({ id, type: "canvas", duration, drawFunction: () => {} }) as unknown as Composition["scenes"][number];

describe("getCompositionFrames", () => {
  it("equals the scene-sum when nothing extends past the scenes", () => {
    const c = comp({ scenes: [scene("a", 5), scene("b", 3)] });
    expect(getCompositionFrames(c)).toBe(getTotalFrames(c)); // 240
  });
  it("extends to an overlay that ends after the last scene", () => {
    const c = comp({
      scenes: [scene("a", 5), scene("b", 3)],
      overlays: [{ id: "o1", kind: "text", startTime: 6, duration: 4, z: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, text: "hi", font: "48px Inter", color: "#fff" } as unknown as Overlay],
    });
    expect(getCompositionFrames(c)).toBe(Math.round(10 * 30)); // 300
  });
  it("extends to an audio clip that ends after the last scene", () => {
    const c = comp({
      scenes: [scene("a", 5)],
      audioClips: [{ id: "c1", kind: "standalone", fileId: "f", startTime: 4, duration: 8 } as unknown as AudioClip],
    });
    expect(getCompositionFrames(c)).toBe(Math.round(12 * 30)); // 360
  });
  it("returns 0 for an empty composition", () => {
    expect(getCompositionFrames(comp({}))).toBe(0);
  });
});
