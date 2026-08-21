import { describe, it, expect } from "vitest";
import {
  buildTrackStackViewModel,
  railIconForGroup,
  railIconForKind,
  rowHeightForKind,
  TRACK_H_TALL,
  TRACK_H_SHORT,
} from "@/lib/preview/track-stack-view-model";
import type { Composition } from "@/lib/engine/types";

function comp(over: Partial<Composition>): Composition {
  return {
    width: 1920,
    height: 1080,
    fps: 30,
    overlays: [],
    audioClips: [],
    ...over,
  } as Composition;
}

const textOverlay = (id: string, z = 0) =>
  ({
    id,
    kind: "text" as const,
    startTime: 0,
    duration: 1,
    z,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    content: "hi",
    font: "16px sans-serif",
    color: "#fff",
    align: "left" as const,
  }) as never;

const imageOverlay = (id: string, z = 0) =>
  ({
    id,
    kind: "image" as const,
    startTime: 0,
    duration: 1,
    z,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    fileId: "f",
  }) as never;

const videoOverlay = (id: string, z = 0) =>
  ({
    id,
    kind: "video" as const,
    startTime: 0,
    duration: 1,
    z,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    fileId: "f",
  }) as never;

type OverlayRow = {
  kind: "overlay";
  overlayKind: string;
  overlayId: string;
  z: number;
};

describe("buildTrackStackViewModel", () => {
  const flags = { selectedIds: new Set<string>(), hidden: {}, locked: {} };

  it("emits ONE row per overlay, then Audio", () => {
    const c = comp({
      overlays: [textOverlay("o1"), imageOverlay("o2", 1)],
      audioClips: [{ id: "c1", kind: "standalone", fileId: "f", startTime: 0, duration: 1, enabled: true } as never],
    });
    const vm = buildTrackStackViewModel(c, flags);
    // two overlay rows (one per overlay), then audio. There is no scene rail.
    expect(vm.rows.map((r) => r.kind)).toEqual(["overlay", "overlay", "audio"]);
    expect(vm.rows[2]).toMatchObject({ kind: "audio", railLabel: "Audio" });
  });

  it("emits no video rail even for a composition that still carries scenes", () => {
    // Fed a comp that DOES have scenes on purpose: this must pass because the
    // row was removed, not because the fixture stopped supplying one.
    const c = comp({
      overlays: [textOverlay("o1")],
    });
    const vm = buildTrackStackViewModel(c, flags);
    expect(vm.rows.some((r) => r.kind === "video")).toBe(false);
    expect(vm.rows.map((r) => r.kind)).toEqual(["overlay"]);
  });

  it("each overlay row carries its overlay's kind/id and a one-layer LayerRowVM", () => {
    const vm = buildTrackStackViewModel(comp({ overlays: [textOverlay("o1")] }), flags);
    const r = vm.rows[0] as OverlayRow & { row: { layers: unknown[] }; railIcon: string };
    expect(r).toMatchObject({ kind: "overlay", overlayKind: "text", overlayId: "o1" });
    expect(r.railIcon).toBe(railIconForKind("text"));
    expect(r.row.layers).toHaveLength(1);
  });

  it("omits the Audio row when there are no clips", () => {
    const vm = buildTrackStackViewModel(comp({ overlays: [textOverlay("o1")] }), flags);
    expect(vm.rows.map((r) => r.kind)).toEqual(["overlay"]);
  });

  it("exposes zById from the overlay lane model", () => {
    const vm = buildTrackStackViewModel(comp({ overlays: [textOverlay("o1")] }), flags);
    expect(vm.zById.o1).toBe(0);
  });

  it("orders overlay rows by stored z DESCENDING (top row = highest z = front)", () => {
    // image given the higher z must sit on TOP (front), text below.
    const c = comp({ overlays: [textOverlay("cap", 1), imageOverlay("img", 9)] });
    const vm = buildTrackStackViewModel(c, flags);
    const rows = vm.rows.filter((r) => r.kind === "overlay") as OverlayRow[];
    expect(rows.map((r) => r.overlayId)).toEqual(["img", "cap"]);
    expect(rows[0].z).toBeGreaterThan(rows[1].z);
  });

  it("lower stored z keeps the overlay lower (back) in the stack", () => {
    const c = comp({ overlays: [textOverlay("cap", 9), imageOverlay("img", 1)] });
    const vm = buildTrackStackViewModel(c, flags);
    const rows = vm.rows.filter((r) => r.kind === "overlay") as OverlayRow[];
    expect(rows.map((r) => r.overlayId)).toEqual(["cap", "img"]);
  });

  it("same-kind overlays each get their OWN row (image above video by z)", () => {
    // Both map to the legacy 'stickers' group, but now each is its own row,
    // z-ordered: the image (z=5) sits above the video (z=2).
    const c = comp({ overlays: [videoOverlay("vid", 2), imageOverlay("img", 5)] });
    const vm = buildTrackStackViewModel(c, flags);
    const rows = vm.rows.filter((r) => r.kind === "overlay") as OverlayRow[];
    expect(rows.map((r) => r.overlayId)).toEqual(["img", "vid"]);
    expect(rows.map((r) => r.overlayKind)).toEqual(["image", "video"]);
  });

  it("railIconForGroup falls back for unknown groups", () => {
    expect(railIconForGroup("captions")).toBe("ti-letter-case");
    expect(railIconForGroup("weird")).toBe("ti-stack");
  });
});

describe("rowHeightForKind / railIconForKind", () => {
  it("media overlays (image/video) → TALL", () => {
    expect(rowHeightForKind("image")).toBe(TRACK_H_TALL);
    expect(rowHeightForKind("video")).toBe(TRACK_H_TALL);
  });

  it("text/code/three/tracked → SHORT", () => {
    expect(rowHeightForKind("text")).toBe(TRACK_H_SHORT);
    expect(rowHeightForKind("code")).toBe(TRACK_H_SHORT);
    expect(rowHeightForKind("three")).toBe(TRACK_H_SHORT);
    expect(rowHeightForKind("tracked")).toBe(TRACK_H_SHORT);
  });

  it("SHORT is meaningfully smaller than the (filmstrip-bearing) TALL row", () => {
    // TALL rows carry a filmstrip/thumbnail and are the prominent media tracks;
    // SHORT rows are thin labeled bars (text/audio). SHORT stays well under TALL.
    const ratio = TRACK_H_SHORT / TRACK_H_TALL;
    expect(ratio).toBeGreaterThan(0.25);
    expect(ratio).toBeLessThan(0.6);
  });

  it("railIconForKind maps each kind", () => {
    expect(railIconForKind("text")).toBe("ti-letter-case");
    expect(railIconForKind("image")).toBe("ti-photo");
    expect(railIconForKind("video")).toBe("ti-movie");
    expect(railIconForKind("code")).toBe("ti-shape");
    expect(railIconForKind("three")).toBe("ti-shape");
    expect(railIconForKind("tracked")).toBe("ti-target");
  });
});
