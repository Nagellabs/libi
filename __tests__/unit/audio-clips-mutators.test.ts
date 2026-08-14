import { describe, it, expect } from "vitest";
import {
  addClip,
  updateClip,
  removeClip,
  unlinkClip,
  relinkClipToOverlay,
  splitClip,
  findInlineClipForScene,
} from "@/lib/composition/audio-clips";
import type { PersistedAudioClip, CompositionManifest } from "@/lib/composition/persistence";

const manifest = (clips: PersistedAudioClip[] = []): CompositionManifest => ({
  sceneOrder: [],
  width: 1920,
  height: 1080,
  fps: 30,
  audioClips: clips,
});

const clip = (id: string, overrides: Partial<PersistedAudioClip> = {}): PersistedAudioClip => ({
  id,
  kind: "standalone",
  fileId: "f1",
  startTime: 0,
  duration: 10,
  trimStart: 0,
  volume: 1,
  enabled: true,
  ...overrides,
});

describe("audio-clips mutators", () => {
  it("addClip appends and returns the new id", () => {
    const m = manifest();
    const c = clip("c1");
    const out = addClip(m, c);
    expect(out.audioClips).toHaveLength(1);
    expect(out.audioClips![0]).toEqual(c);
  });

  it("updateClip applies a partial patch", () => {
    const m = manifest([clip("c1", { volume: 1 })]);
    const out = updateClip(m, "c1", { volume: 0.5, enabled: false });
    expect(out!.audioClips![0]).toMatchObject({ volume: 0.5, enabled: false, fileId: "f1" });
  });

  it("updateClip returns null for missing id", () => {
    expect(updateClip(manifest(), "nope", { volume: 0.5 })).toBeNull();
  });

  it("removeClip strips the clip", () => {
    const m = manifest([clip("a"), clip("b")]);
    const out = removeClip(m, "a");
    expect(out!.audioClips!.map((c) => c.id)).toEqual(["b"]);
  });

  it("unlinkClip removes linkedSceneId and changes kind to standalone", () => {
    const m = manifest([clip("c1", { kind: "inline", linkedSceneId: "scene-x" })]);
    const out = unlinkClip(m, "c1");
    expect(out!.audioClips![0].kind).toBe("standalone");
    expect(out!.audioClips![0].linkedSceneId).toBeUndefined();
  });

  it("unlinkClip KEEPS linkedOverlayId (detached audio remembers its source video)", () => {
    const m = manifest([clip("c1", { kind: "inline", linkedOverlayId: "vid-x" })]);
    const out = unlinkClip(m, "c1");
    expect(out!.audioClips![0].kind).toBe("standalone");
    // Detached-but-remembered: keeps the link so it sits next to its video and
    // is named "detached audio of video — X" (only the SCENE link is dropped).
    expect(out!.audioClips![0].linkedOverlayId).toBe("vid-x");
  });

  it("unlinkClip SNAPS the clip to its linked video's current window (detach never repositions)", () => {
    // The clip's persisted timing has drifted from the video (e.g. the video was
    // moved while coupled). Detaching must snap the clip onto the video's window
    // so the detached row materializes exactly where the coupled strip was shown.
    const m: CompositionManifest = {
      ...manifest([
        clip("c1", { kind: "inline", linkedOverlayId: "vid-x", startTime: 0, duration: 5, trimStart: 0 }),
      ]),
      overlays: [
        { id: "vid-x", kind: "video", fileId: "fv", startTime: 7, duration: 9, trim: { start: 3, end: 12 }, rect: { x: 0, y: 0, width: 10, height: 10 }, z: 0, opacity: 1 },
      ] as unknown as CompositionManifest["overlays"],
    };
    const out = unlinkClip(m, "c1");
    const c = out!.audioClips![0];
    expect(c.kind).toBe("standalone");
    expect(c.linkedOverlayId).toBe("vid-x");
    expect(c.startTime).toBe(7); // snapped to the video's CURRENT start
    expect(c.duration).toBe(9);
    expect(c.trimStart).toBe(3);
    // SEEDS the vertical order to z − 0.5 so the detached track materializes
    // directly BELOW its source video (z 0 → -0.5).
    expect(c.timelineOrder).toBe(-0.5);
  });

  it("unlinkClip seeds timelineOrder = video.z − 0.5 (sorts directly below the video)", () => {
    const m: CompositionManifest = {
      ...manifest([clip("c1", { kind: "inline", linkedOverlayId: "vid-x" })]),
      overlays: [
        { id: "vid-x", kind: "video", fileId: "fv", startTime: 0, duration: 5, rect: { x: 0, y: 0, width: 10, height: 10 }, z: 4, opacity: 1 },
      ] as unknown as CompositionManifest["overlays"],
    };
    const out = unlinkClip(m, "c1");
    expect(out!.audioClips![0].timelineOrder).toBe(3.5); // 4 − 0.5
  });

  it("unlinkClip with an orphaned/missing overlay link keeps the clip's own timing + no order", () => {
    const m = manifest([
      clip("c1", { kind: "inline", linkedOverlayId: "ghost", startTime: 2, duration: 4, trimStart: 1 }),
    ]);
    const out = unlinkClip(m, "c1");
    const c = out!.audioClips![0];
    expect(c.kind).toBe("standalone");
    expect(c.startTime).toBe(2); // unchanged — no live overlay to snap to
    expect(c.duration).toBe(4);
    expect(c.trimStart).toBe(1);
    // No anchor video → no timelineOrder seeded.
    expect(c.timelineOrder).toBeUndefined();
  });

  it("relinkClipToOverlay re-attaches a standalone clip to its video + snaps timing + clears order", () => {
    const m: CompositionManifest = {
      ...manifest([clip("c1", { kind: "standalone", fileId: "fv", startTime: 0, duration: 5, timelineOrder: 2.5 })]),
      overlays: [
        { id: "vid-x", kind: "video", fileId: "fv", startTime: 3, duration: 8, trim: { start: 2, end: 10 }, rect: { x: 0, y: 0, width: 10, height: 10 }, z: 0, opacity: 1 },
      ] as unknown as CompositionManifest["overlays"],
    };
    const out = relinkClipToOverlay(m, "c1", "vid-x");
    expect(out).not.toBeNull();
    const c = out!.audioClips![0];
    expect(c.kind).toBe("inline");
    expect(c.linkedOverlayId).toBe("vid-x");
    expect(c.startTime).toBe(3); // snapped to the overlay
    expect(c.duration).toBe(8);
    expect(c.trimStart).toBe(2);
    // Coupled audio is positioned by the video — the detached vertical key is
    // cleared so a later re-detach starts fresh.
    expect(c.timelineOrder).toBeUndefined();
  });

  it("relinkClipToOverlay returns null for a missing clip or non-video overlay", () => {
    const m = manifest([clip("c1")]);
    expect(relinkClipToOverlay(m, "nope", "vid-x")).toBeNull();
    expect(relinkClipToOverlay(m, "c1", "vid-x")).toBeNull(); // no overlays
  });

  it("splitClip at relative time t produces two clips covering the same range", () => {
    const m = manifest([clip("c1", { startTime: 5, duration: 10, trimStart: 2 })]);
    const out = splitClip(m, "c1", 8);
    expect(out!.audioClips).toHaveLength(2);
    const [first, second] = out!.audioClips!;
    expect(first).toMatchObject({ id: "c1", startTime: 5, duration: 3, trimStart: 2 });
    expect(second).toMatchObject({ startTime: 8, duration: 7, trimStart: 5 });
    expect(second.id).not.toBe("c1");
  });

  it("splitClip at the boundary returns null (nothing to split)", () => {
    const m = manifest([clip("c1", { startTime: 5, duration: 10 })]);
    expect(splitClip(m, "c1", 5)).toBeNull();
    expect(splitClip(m, "c1", 15)).toBeNull();
  });

  it("findInlineClipForScene returns the linked clip", () => {
    const m = manifest([
      clip("a", { kind: "inline", linkedSceneId: "s1" }),
      clip("b", { kind: "standalone" }),
    ]);
    expect(findInlineClipForScene(m, "s1")?.id).toBe("a");
    expect(findInlineClipForScene(m, "s2")).toBeNull();
  });
});
