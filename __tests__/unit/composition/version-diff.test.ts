import { describe, it, expect } from "vitest";
import { diffManifests } from "@/lib/composition/version-diff";
import type { CompositionManifest, PersistedCanvasScene } from "@/lib/composition/persistence";

const base = (): CompositionManifest => ({
  sceneOrder: [], width: 1920, height: 1080, fps: 30, audioClips: [], overlays: [], scenes: [],
});
const canvas = (id: string, name: string, duration = 2): PersistedCanvasScene => ({
  id, type: "canvas", name, duration, drawFunction: "// noop",
});

describe("diffManifests", () => {
  it("returns an empty diff + unchanged strip for identical manifests", () => {
    const m = { ...base(), sceneOrder: ["a"], scenes: [canvas("a", "A")] };
    const d = diffManifests(m, m);
    expect(d.scenes).toEqual({ added: [], removed: [], changed: [] });
    expect(d.overlays).toEqual({ added: [], removed: [], changed: [] });
    expect(d.audioClips).toEqual({ added: [], removed: [], changed: [] });
    expect(d.sceneStrip).toEqual([
      { id: "a", name: "A", type: "canvas", duration: 2, fileId: null, changeKind: "unchanged" },
    ]);
    expect(d.totalChanges).toBe(0);
  });

  it("classifies added / removed / changed scenes with type+duration and reasons", () => {
    const older = { ...base(), sceneOrder: ["a", "b"], scenes: [canvas("a", "A", 2), canvas("b", "B")] };
    const newer = {
      ...base(),
      sceneOrder: ["a", "c"],
      scenes: [canvas("a", "A2", 3), canvas("c", "C", 5)],
    };
    const d = diffManifests(older, newer);
    expect(d.scenes.added).toEqual([{ id: "c", name: "C", type: "canvas", duration: 5, fileId: null }]);
    expect(d.scenes.removed).toEqual([{ id: "b", name: "B", type: "canvas", duration: 2, fileId: null }]);
    expect(d.scenes.changed[0]).toMatchObject({ id: "a", name: "A2" });
    expect(d.scenes.changed[0].reasons).toEqual(expect.arrayContaining(["renamed", "duration changed"]));
    // strip = scenes of `newer`, in order, with change kind + removed appended as ghosts
    expect(d.sceneStrip.map((t) => [t.id, t.changeKind])).toEqual([
      ["a", "changed"],
      ["c", "added"],
      ["b", "removed"],
    ]);
    expect(d.totalChanges).toBe(3);
  });

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
