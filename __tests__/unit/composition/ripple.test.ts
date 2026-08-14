/**
 * Pure ripple-close-gap timeline math — the "ripple delete" half of libi's two
 * delete commands (see lib/composition/ripple.ts for the semantics writeup).
 */
import { describe, expect, it } from "vitest";
import { rippleCloseGap } from "@/lib/composition/ripple";
import type {
  CompositionManifest,
  PersistedOverlay,
  PersistedAudioClip,
} from "@/lib/composition/persistence";

// Timeline: A[0-5) B[5-10) C[10-15), caption D[12-14), bg BG[0-15).
function manifest(): CompositionManifest {
  const rect = { x: 0, y: 0, width: 1920, height: 1080 };
  const overlays: PersistedOverlay[] = [
    { id: "BG", kind: "video", fileId: "f0", startTime: 0, duration: 15, z: 0, opacity: 1, rect },
    { id: "A", kind: "video", fileId: "f1", startTime: 0, duration: 5, z: 1, opacity: 1, rect },
    { id: "B", kind: "video", fileId: "f2", startTime: 5, duration: 5, z: 2, opacity: 1, rect },
    { id: "C", kind: "video", fileId: "f3", startTime: 10, duration: 5, z: 3, opacity: 1, rect },
    {
      id: "D",
      kind: "text",
      startTime: 12,
      duration: 2,
      z: 4,
      opacity: 1,
      rect: { x: 0, y: 0, width: 100, height: 50 },
      content: "hi",
      font: "sans-serif",
      color: "#fff",
      align: "center",
    },
  ];
  const audioClips: PersistedAudioClip[] = [
    {
      id: "aC",
      kind: "inline",
      fileId: "f3",
      linkedOverlayId: "C",
      startTime: 10,
      duration: 5,
      trimStart: 0,
      volume: 1,
      enabled: true,
    },
  ];
  return {
    width: 1920,
    height: 1080,
    fps: 30,
    scenes: [],
    sceneOrder: [],
    overlays,
    audioClips,
  };
}

const byId = (m: CompositionManifest, id: string) =>
  (m.overlays ?? []).find((o) => o.id === id)!;

describe("rippleCloseGap", () => {
  it("shifts everything starting at/after the gap left by its duration", () => {
    const out = rippleCloseGap(manifest(), 5, 5); // B deleted: [5,10)
    expect(byId(out, "C").startTime).toBe(5);
    expect(byId(out, "D").startTime).toBe(7);
  });

  it("leaves items that START BEFORE the gap alone, even when they span it", () => {
    const out = rippleCloseGap(manifest(), 5, 5);
    expect(byId(out, "A").startTime).toBe(0);
    expect(byId(out, "BG").startTime).toBe(0); // spans the gap — must NOT move
    expect(byId(out, "BG").duration).toBe(15);
  });

  it("moves linked audio in lock-step with its overlay", () => {
    const out = rippleCloseGap(manifest(), 5, 5);
    expect(out.audioClips!.find((c) => c.id === "aC")!.startTime).toBe(5);
  });

  it("never produces a negative startTime", () => {
    const out = rippleCloseGap(manifest(), 0, 999);
    for (const o of out.overlays ?? []) {
      expect(o.startTime).toBeGreaterThanOrEqual(0);
    }
    for (const c of out.audioClips ?? []) {
      expect(c.startTime).toBeGreaterThanOrEqual(0);
    }
  });

  it("is a no-op for a zero-length gap", () => {
    expect(rippleCloseGap(manifest(), 5, 0)).toEqual(manifest());
  });
});
