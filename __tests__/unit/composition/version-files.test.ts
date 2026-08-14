import { describe, it, expect } from "vitest";
import { collectReferencedFileIds, computeMissingRefs } from "@/lib/composition/version-files";
import type { CompositionManifest } from "@/lib/composition/persistence";

const base = (): CompositionManifest => ({
  sceneOrder: [], width: 1920, height: 1080, fps: 30, audioClips: [], overlays: [], scenes: [],
});

describe("collectReferencedFileIds", () => {
  it("gathers fileIds from image/video overlays and audio clips (canvas scenes reference none)", () => {
    const m: CompositionManifest = {
      ...base(),
      scenes: [
        { id: "s2", type: "canvas", name: "Hook", duration: 2, drawFunction: "//" },
      ],
      overlays: [
        { id: "v1", kind: "video", startTime: 0, duration: 5, rect: { x: 0, y: 0, width: 1, height: 1 }, z: 0, opacity: 1, fileId: "vid-1" },
        { id: "o1", kind: "image", startTime: 0, duration: 1, rect: { x: 0, y: 0, width: 1, height: 1 }, z: 1, opacity: 1, fileId: "img-1" },
        { id: "o2", kind: "text", startTime: 0, duration: 1, rect: { x: 0, y: 0, width: 1, height: 1 }, z: 0, opacity: 1, content: "x", font: "Inter", color: "#fff", align: "center" },
      ],
      audioClips: [
        { id: "c1", kind: "standalone", fileId: "aud-1", startTime: 0, duration: 1, trimStart: 0, volume: 1, enabled: true },
      ],
    };
    const refs = collectReferencedFileIds(m);
    expect(refs.map((r) => [r.fileId, r.refKind, r.refName]).sort()).toEqual(
      [["aud-1", "audio", "audio clip"], ["img-1", "overlay", "image overlay"], ["vid-1", "overlay", "video overlay"]].sort(),
    );
  });

  it("names an inline clip after its linked video overlay", () => {
    const m: CompositionManifest = {
      ...base(),
      overlays: [
        { id: "v1", kind: "video", startTime: 0, duration: 5, rect: { x: 0, y: 0, width: 1, height: 1 }, z: 0, opacity: 1, fileId: "vid-1", displayName: "Demo" },
      ],
      audioClips: [
        { id: "c1", kind: "inline", fileId: "aud-1", startTime: 0, duration: 5, trimStart: 0, volume: 1, enabled: true, linkedOverlayId: "v1" },
      ],
    };
    const audioRef = collectReferencedFileIds(m).find((r) => r.refKind === "audio");
    expect(audioRef).toEqual({ fileId: "aud-1", refKind: "audio", refName: "Demo audio" });
  });
});

describe("computeMissingRefs", () => {
  it("returns only refs whose fileId is not in the existing set", () => {
    const refs = [
      { fileId: "a", refKind: "scene" as const, refName: "S" },
      { fileId: "b", refKind: "overlay" as const, refName: "O" },
    ];
    expect(computeMissingRefs(refs, new Set(["a"]))).toEqual([{ fileId: "b", refKind: "overlay", refName: "O" }]);
  });
});
