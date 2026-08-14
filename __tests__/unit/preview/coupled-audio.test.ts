import { describe, it, expect } from "vitest";
import { buildTrackStackViewModel } from "@/lib/preview/track-stack-view-model";
import type { Composition } from "@/lib/engine/types";

const FLAGS = { selectedIds: new Set<string>(), hidden: {}, locked: {} };

function comp(overlays: unknown[], audioClips: unknown[]): Composition {
  return {
    fps: 30,
    width: 1920,
    height: 1080,
    scenes: [],
    overlays,
    audioClips,
  } as unknown as Composition;
}

const videoOverlay = (id: string, z: number) => ({
  id,
  kind: "video",
  startTime: 0,
  duration: 5,
  z,
  rect: { x: 0, y: 0, width: 1920, height: 1080 },
  opacity: 1,
  fileId: `file-${id}`,
});

const inlineClip = (id: string, overlayId: string) => ({
  id,
  kind: "inline",
  fileId: "f",
  startTime: 0,
  duration: 5,
  trimStart: 0,
  volume: 1,
  enabled: true,
  linkedOverlayId: overlayId,
});

describe("buildTrackStackViewModel — video audio rows", () => {
  it("emits a coupledAudio row directly after its video row, not in the Audio section", () => {
    const vm = buildTrackStackViewModel(
      comp([videoOverlay("v1", 0)], [inlineClip("c1", "v1")]),
      FLAGS,
    );
    const kinds = vm.rows.map((r) => r.kind);
    // video overlay row, then its coupled audio strip — no standalone Audio row.
    expect(kinds).toEqual(["overlay", "coupledAudio"]);
    const coupled = vm.rows.find((r) => r.kind === "coupledAudio");
    expect(coupled).toMatchObject({ clipId: "c1", ownerOverlayId: "v1", enabled: true });
  });

  it("a DETACHED clip (standalone + still remembering its video) becomes an INDEPENDENT audioTrack row, interleaved by order — NOT a coupledAudio under the video", () => {
    // Seeded just below the video (z 0 → order -0.5) so it materializes directly
    // under the video on detach. It's a free-standing row (kind audioTrack), not
    // a coupledAudio strip tied to the video.
    const detached = { ...inlineClip("c1", "v1"), kind: "standalone", timelineOrder: -0.5 };
    const vm = buildTrackStackViewModel(comp([videoOverlay("v1", 0)], [detached]), FLAGS);
    const kinds = vm.rows.map((r) => r.kind);
    // Interleaved by order: the video (z 0) sorts above the detached track
    // (order -0.5) → overlay row, then the independent audioTrack row.
    expect(kinds).toEqual(["overlay", "audioTrack"]);
    const row = vm.rows.find((r) => r.kind === "audioTrack");
    expect(row).toMatchObject({ clipId: "c1", ownerOverlayId: "v1", enabled: true, order: -0.5 });
    // No coupledAudio row for a detached clip.
    expect(vm.rows.some((r) => r.kind === "coupledAudio")).toBe(false);
  });

  it("a detached audioTrack interleaves among overlays by its timelineOrder (independent of the video)", () => {
    // Two video overlays z 2 and z 1; a clip detached from v-top dragged BELOW
    // v-bot (order 0.5 < 1). The track sorts between v-bot and... here below both,
    // proving it's not pinned under its source video.
    const detached = { ...inlineClip("c1", "vtop"), kind: "standalone", timelineOrder: 0.5 };
    const vm = buildTrackStackViewModel(
      comp([videoOverlay("vtop", 2), videoOverlay("vbot", 1)], [detached]),
      FLAGS,
    );
    // z2 (vtop) → z1 (vbot) → order 0.5 (detached, below both videos).
    const seq = vm.rows.map((r) =>
      r.kind === "overlay" ? r.overlayId : r.kind === "audioTrack" ? `track:${r.clipId}` : r.kind,
    );
    expect(seq).toEqual(["vtop", "vbot", "track:c1"]);
  });

  it("a fully FREE clip (no link) goes to the bottom Audio section", () => {
    const free = { ...inlineClip("c1", "v1"), kind: "standalone", linkedOverlayId: undefined };
    const vm = buildTrackStackViewModel(comp([videoOverlay("v1", 0)], [free]), FLAGS);
    const kinds = vm.rows.map((r) => r.kind);
    expect(kinds).toEqual(["overlay", "audio"]);
    expect((vm.rows.find((r) => r.kind === "audio") as { clipIds: string[] }).clipIds).toEqual(["c1"]);
  });

  it("a clip whose linked overlay is GONE (orphan) is not parked under any video → bottom Audio", () => {
    const vm = buildTrackStackViewModel(comp([], [inlineClip("c1", "ghost")]), FLAGS);
    expect(vm.rows.map((r) => r.kind)).toEqual(["audio"]);
  });
});
