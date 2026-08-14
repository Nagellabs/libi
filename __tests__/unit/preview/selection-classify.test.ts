import { describe, it, expect } from "vitest";
import { classifySelection } from "@/lib/preview/selection-classify";
import type { Composition } from "@/lib/engine/types";

const composition = {
  width: 1920, height: 1080, fps: 30,
  scenes: [{ id: "s1", name: "S1", type: "canvas", duration: 1, drawFunction: "" }],
  overlays: [{ id: "o1", kind: "text", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 1, height: 1 }, text: "" }],
  audioClips: [
    { id: "a1", kind: "inline", fileId: "f1", startTime: 0, duration: 1, trimStart: 0, volume: 1, enabled: true, linkedSceneId: "s1" },
  ],
} as unknown as Composition;

describe("classifySelection", () => {
  it("classifies an overlay id", () => {
    const r = classifySelection("o1", composition);
    expect(r?.kind).toBe("overlay");
  });
  it("classifies a scene id with its index", () => {
    const r = classifySelection("s1", composition);
    expect(r).toMatchObject({ kind: "scene", index: 0 });
  });
  it("classifies an audio-clip id", () => {
    const r = classifySelection("a1", composition);
    expect(r).toMatchObject({ kind: "audioClip", clip: { id: "a1", fileId: "f1" } });
  });
  it("returns null for unknown / null id or null composition", () => {
    expect(classifySelection("nope", composition)).toBeNull();
    expect(classifySelection(null, composition)).toBeNull();
    expect(classifySelection("s1", null)).toBeNull();
  });
});
