import { describe, it, expect } from "vitest";
import { diffManifests } from "@/lib/composition/version-diff";
import type { CompositionManifest, PersistedOverlay } from "@/lib/composition/persistence";

const base = (): CompositionManifest => ({
  width: 1920, height: 1080, fps: 30, audioClips: [], overlays: [], 
});
/** A full-frame background layer — what the retired canvas scenes became. */
const canvas = (id: string, name: string, duration = 2): PersistedOverlay => ({
  id, kind: "code", displayName: name, startTime: 0, duration, z: 0,
  rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "// noop",
} as PersistedOverlay);

describe("diffManifests", () => {
  it("labels overlays and audio clips by content/kind", () => {
    const textOverlay = (id: string, content: string) => ({
      id, kind: "text" as const, startTime: 0, duration: 1,
      rect: { x: 0, y: 0, width: 10, height: 10 }, z: 0, opacity: 1,
      content, font: "Inter", color: "#fff", align: "center" as const,
    });
    const clip = (id: string, label?: string) => ({
      id, kind: "standalone" as const, fileId: "f", startTime: 0, duration: 1,
      trimStart: 0, volume: 1, enabled: true, label,
    });
    const older = { ...base(), overlays: [textOverlay("o1", "hi")], audioClips: [clip("c1", "voice")] };
    const newer = { ...base(), overlays: [textOverlay("o1", "hi"), textOverlay("o2", "JUST FINISHING")], audioClips: [] };
    const d = diffManifests(older, newer);
    expect(d.overlays.added).toEqual([{ id: "o2", kind: "text", label: "JUST FINISHING" }]);
    expect(d.audioClips.removed).toEqual([{ id: "c1", kind: "standalone", label: "voice" }]);
  });

  it("surfaces the tracked text in a tracked overlay's label", () => {
    const tracked = (id: string, text: string) => ({
      id, kind: "tracked" as const, startTime: 0, duration: 1,
      rect: { x: 0, y: 0, width: 10, height: 10 }, z: 0, opacity: 1,
      trackId: "t1",
      content: { kind: "text" as const, content: text, font: "Inter", color: "#fff", align: "center" as const },
      fit: "rect" as const, scale: 1, smoothing: "linear" as const,
    });
    const d = diffManifests({ ...base() }, { ...base(), overlays: [tracked("o1", "WATCH THIS")] });
    expect(d.overlays.added).toEqual([{ id: "o1", kind: "tracked", label: "tracked: WATCH THIS" }]);
  });
});
