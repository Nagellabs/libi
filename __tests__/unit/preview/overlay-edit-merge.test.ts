import { describe, it, expect } from "vitest";
import { mergeOverlayEdits } from "@/lib/preview/overlay-edit-merge";
import { createOverlayEditStore } from "@/lib/preview/overlay-edit-store";
import type { Composition } from "@/lib/engine/types";

const comp = {
  width: 1920, height: 1080, fps: 30, scenes: [], sceneOrder: [], audioClips: [],
  overlays: [
    { id: "a", kind: "text", startTime: 0, duration: 2, z: 0, opacity: 1,
      rect: { x: 0, y: 0, w: 10, h: 10 }, content: "hi", font: "32px Inter",
      color: "#fff", align: "center" },
  ],
} as unknown as Composition;

describe("mergeOverlayEdits", () => {
  it("returns the same reference when there are no edits", () => {
    const store = createOverlayEditStore();
    expect(mergeOverlayEdits(comp, store.getAll())).toBe(comp);
  });
  it("overlays the pending patch onto the matching overlay", () => {
    const store = createOverlayEditStore();
    store.commit("a", { opacity: 0.3 });
    const merged = mergeOverlayEdits(comp, store.getAll())!;
    expect(merged.overlays![0].opacity).toBe(0.3);
    expect(merged).not.toBe(comp);
    expect(comp.overlays![0].opacity).toBe(1);
  });
  it("ignores edits for unknown overlay ids", () => {
    const store = createOverlayEditStore();
    store.commit("ghost", { opacity: 0.1 });
    const merged = mergeOverlayEdits(comp, store.getAll())!;
    expect(merged.overlays!.map((o) => o.id)).toEqual(["a"]);
  });
  it("returns null when composition is null", () => {
    const store = createOverlayEditStore();
    store.commit("a", { opacity: 0.3 });
    expect(mergeOverlayEdits(null, store.getAll())).toBeNull();
  });
  it("merges committed entries, ignores preview entries", () => {
    const store = createOverlayEditStore();
    store.preview("o1", { z: 90 } as never); // preview — must NOT merge
    store.commit("o2", { z: 45 } as never); // committed — must merge
    const localComp = {
      overlays: [
        { id: "o1", z: 0 },
        { id: "o2", z: 0 },
      ],
    } as never as Composition;
    const out = mergeOverlayEdits(localComp, store.getCommitted())!;
    expect((out.overlays![0] as { z: number }).z).toBe(0); // preview ignored
    expect((out.overlays![1] as { z: number }).z).toBe(45); // committed applied
  });
});
