import { describe, it, expect } from "vitest";
import { collectVideoSeekTargets } from "@/lib/engine/renderer";
import type { Composition, Overlay } from "@/lib/engine/types";

/** A full-frame base VIDEO OVERLAY at `startTime` — the modern spelling of a
 *  base video. (Video scenes were retired; scenes are canvas-only and decode
 *  no video, so every seek target now comes from an overlay.) */
const videoLayer = (
  id: string,
  duration: number,
  startTime = 0,
  trimStart = 0,
): Overlay =>
  ({
    id,
    kind: "video",
    fileId: `file-${id}`,
    videoUrl: `/v/${id}`,
    startTime,
    duration,
    z: 0,
    opacity: 1,
    fit: "cover",
    rect: { x: 0, y: 0, width: 1920, height: 1080 },
    trim: { start: trimStart, end: trimStart + duration },
  }) as unknown as Overlay;

const canvasScene = (id: string, duration: number): Overlay =>
  ({
    id,
    kind: "code",
    startTime: 0,
    duration,
    z: 0,
    opacity: 1,
    rect: { x: 0, y: 0, width: 1920, height: 1080 },
    drawFunction: "",
  }) as unknown as Overlay;

const comp = (backgrounds: Overlay[], overlays: Overlay[] = []): Composition =>
  ({
    width: 1920,
    height: 1080,
    fps: 30,
    overlays: [...backgrounds, ...overlays],
  }) as unknown as Composition;

describe("collectVideoSeekTargets", () => {
  it("returns no targets for a code-only composition", () => {
    const c = comp([canvasScene("a", 4)]);
    expect(collectVideoSeekTargets(c, 0)).toEqual([]);
    expect(collectVideoSeekTargets(c, 60)).toEqual([]);
  });

  it("maps a global frame to the active video layer at layer-local time", () => {
    // two back-to-back 4s video layers @ 30fps -> 120 frames each.
    const c = comp([], [videoLayer("av_a", 4, 0), videoLayer("av_b", 4, 4)]);
    // frame 0 -> layer a, local t=0
    expect(collectVideoSeekTargets(c, 0)).toEqual([{ id: "av_a", time: 0 }]);
    // frame 30 -> layer a, local t=1
    expect(collectVideoSeekTargets(c, 30)).toEqual([{ id: "av_a", time: 1 }]);
    // frame 120 -> layer b, local t=0 (NOT global t=4 — this is what makes the
    // second layer play from its own start instead of freezing)
    expect(collectVideoSeekTargets(c, 120)).toEqual([{ id: "av_b", time: 0 }]);
    // frame 150 -> layer b, local t=1
    expect(collectVideoSeekTargets(c, 150)).toEqual([{ id: "av_b", time: 1 }]);
  });

  it("adds the layer's trim.start offset to the seek time", () => {
    const c = comp([], [videoLayer("trimmed", 4, 0, 2.5)]);
    // local t=1 + trim.start 2.5 = 3.5 into the source file
    expect(collectVideoSeekTargets(c, 30)).toEqual([{ id: "trimmed", time: 3.5 }]);
  });

  it("includes an active video overlay at GLOBAL time minus its startTime", () => {
    const overlay: Overlay = {
      id: "ov",
      kind: "video",
      fileId: "ovf",
      startTime: 0.5,
      duration: 3,
      trim: { start: 1, end: 4 },
      z: 1,
      rect: { x: 0, y: 0, w: 100, h: 100 },
    } as unknown as Overlay;
    const c = comp([], [videoLayer("base", 4), overlay]);
    // frame 30 -> global t=1. overlay active (0.5..3.5).
    // overlay source-time = 1 - 0.5 + 1 (trim) = 1.5
    const targets = collectVideoSeekTargets(c, 30);
    expect(targets).toContainEqual({ id: "base", time: 1 });
    expect(targets).toContainEqual({ id: "ov", time: 1.5 });
  });

  it("excludes overlays that are not active at the frame's time", () => {
    const overlay: Overlay = {
      id: "ov",
      kind: "video",
      fileId: "ovf",
      startTime: 3,
      duration: 1,
      z: 1,
      rect: { x: 0, y: 0, w: 100, h: 100 },
    } as unknown as Overlay;
    const c = comp([], [videoLayer("base", 4), overlay]);
    // frame 30 -> global t=1, overlay starts at 3 -> not active
    const targets = collectVideoSeekTargets(c, 30);
    expect(targets).toEqual([{ id: "base", time: 1 }]);
  });

  it("times overlays on the GLOBAL timeline, not a per-segment local time", () => {
    // Two back-to-back 4s video layers. An overlay scoped to GLOBAL 0.5..1.5s
    // belongs to the FIRST segment only. The old scene-local-time bug evaluated
    // it against each segment's local clock, so it (wrongly) re-activated at the
    // same local offset in the second (and would paint "across all scenes").
    const aOnly: Overlay = {
      id: "ovA",
      kind: "video",
      fileId: "ovfA",
      startTime: 0.5,
      duration: 1, // global 0.5 .. 1.5 — first segment only
      trim: { start: 0, end: 1 },
      z: 1,
      rect: { x: 0, y: 0, w: 100, h: 100 },
    } as unknown as Overlay;
    const c = comp([], [videoLayer("A", 4, 0), videoLayer("B", 4, 4), aOnly]);

    // frame 30 -> global 1.0 (segment A, local 1.0): overlay active.
    expect(collectVideoSeekTargets(c, 30)).toContainEqual({ id: "ovA", time: 0.5 });
    // frame 150 -> global 5.0 (segment B, local 1.0): overlay must be INACTIVE
    // (global 5.0 ∉ [0.5,1.5]) even though segment-local 1.0 ∈ [0.5,1.5].
    expect(collectVideoSeekTargets(c, 150).some((t) => t.id === "ovA")).toBe(false);
  });

  it("includes an overlay scoped to a LATER segment only at its global window", () => {
    // Overlay at global 5.0..6.0 sits over segment B (4..8s). Under segment-local
    // timing it would have needed a local time of 5+, which no 4s segment ever
    // reaches -> it would NEVER show. Assert it shows over segment B.
    const bOnly: Overlay = {
      id: "ovB",
      kind: "video",
      fileId: "ovfB",
      startTime: 5,
      duration: 1, // global 5 .. 6 — segment B
      trim: { start: 0, end: 1 },
      z: 1,
      rect: { x: 0, y: 0, w: 100, h: 100 },
    } as unknown as Overlay;
    const c = comp([], [videoLayer("A", 4, 0), videoLayer("B", 4, 4), bOnly]);

    // frame 30 -> global 1.0 (segment A): inactive.
    expect(collectVideoSeekTargets(c, 30).some((t) => t.id === "ovB")).toBe(false);
    // frame 150 -> global 5.0 (segment B): active. source-time = 5 - 5 + 0 = 0.
    expect(collectVideoSeekTargets(c, 150)).toContainEqual({ id: "ovB", time: 0 });
  });
});
