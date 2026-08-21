import { describe, it, expect } from "vitest";
import { getCompositionFrames } from "@/lib/engine/renderer";
import type { Composition, Overlay, AudioClip } from "@/lib/engine/types";

function comp(partial: Partial<Composition>): Composition {
  return { fps: 30, width: 1920, height: 1080, overlays: [], audioClips: [], ...partial } as Composition;
}
/** A full-frame background layer — what the retired canvas scenes became. */
const bg = (id: string, startTime: number, duration: number) =>
  ({ id, kind: "code", startTime, duration, z: 0, opacity: 1,
     rect: { x: 0, y: 0, width: 1920, height: 1080 }, drawFunction: "" }) as unknown as Overlay;

describe("getCompositionFrames", () => {
  it("extends to an overlay that ends after the last background layer", () => {
    const c = comp({
      overlays: [bg("a", 0, 5), bg("b", 5, 3), { id: "o1", kind: "text", startTime: 6, duration: 4, z: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, text: "hi", font: "48px Inter", color: "#fff" } as unknown as Overlay],
    });
    expect(getCompositionFrames(c)).toBe(Math.round(10 * 30)); // 300
  });
  it("extends to an audio clip that ends after the last background layer", () => {
    const c = comp({
      overlays: [bg("a", 0, 5)],
      audioClips: [{ id: "c1", kind: "standalone", fileId: "f", startTime: 4, duration: 8 } as unknown as AudioClip],
    });
    expect(getCompositionFrames(c)).toBe(Math.round(12 * 30)); // 360
  });
  it("returns 0 for an empty composition", () => {
    expect(getCompositionFrames(comp({}))).toBe(0);
  });
});
