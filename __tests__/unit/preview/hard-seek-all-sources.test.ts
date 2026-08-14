import { describe, it, expect, vi } from "vitest";
import {
  hardSeekAllSources,
  type HardSeekSource,
} from "@/hooks/preview/use-video-sources";
import type { Composition } from "@/lib/engine/types";

/** A fake source recording the (hard)seek calls made against it. */
function fakeSource(withHard: boolean) {
  const seek = vi.fn();
  const hardSeek = withHard ? vi.fn() : undefined;
  const source: HardSeekSource = hardSeek ? { seek, hardSeek } : { seek };
  return { source, seek, hardSeek };
}

function comp(partial: Partial<Composition>): Composition {
  return {
    width: 1920,
    height: 1080,
    fps: 30,
    scenes: [],
    overlays: [],
    audioClips: [],
    ...partial,
  } as Composition;
}

describe("hardSeekAllSources", () => {
  it("hard-seeks a base video overlay at its source-local (trim-offset) time", () => {
    const a = fakeSource(true);
    // One video overlay starting at t=0, trim.start=5 → local at playhead 2s is 7s.
    const composition = comp({
      scenes: [],
      overlays: [
        {
          id: "s1",
          kind: "video",
          fileId: "f1",
          videoUrl: "/x",
          startTime: 0,
          duration: 10,
          z: 0,
          opacity: 1,
          rect: { x: 0, y: 0, width: 1920, height: 1080 },
          trim: { start: 5, end: 15 },
        } as never,
      ],
    });
    const map = new Map([["s1", { source: a.source }]]);
    hardSeekAllSources(composition, 2, map);
    expect(a.hardSeek).toHaveBeenCalledTimes(1);
    expect(a.hardSeek).toHaveBeenCalledWith(7);
    expect(a.seek).not.toHaveBeenCalled();
  });

  it("hard-seeks a video overlay at its overlay-local time", () => {
    const o = fakeSource(true);
    // Overlay starts at t=3 → local at playhead 5s is 2s (no trim).
    const composition = comp({
      overlays: [
        {
          id: "ov1",
          kind: "video",
          fileId: "f2",
          startTime: 3,
          duration: 8,
          z: 0,
          rect: { x: 0, y: 0, w: 100, h: 100 },
        } as never,
      ],
    });
    const map = new Map([["ov1", { source: o.source }]]);
    hardSeekAllSources(composition, 5, map);
    expect(o.hardSeek).toHaveBeenCalledWith(2);
  });

  it("falls back to soft seek when a source lacks hardSeek", () => {
    const a = fakeSource(false);
    const composition = comp({
      overlays: [
        {
          id: "ov1",
          kind: "video",
          fileId: "f2",
          startTime: 0,
          duration: 8,
          z: 0,
          rect: { x: 0, y: 0, w: 100, h: 100 },
        } as never,
      ],
    });
    const map = new Map([["ov1", { source: a.source }]]);
    hardSeekAllSources(composition, 4, map);
    expect(a.seek).toHaveBeenCalledWith(4);
  });

  it("hard-seeks BOTH a base video and an overlay above it on one seek (the bug parity)", () => {
    const base = fakeSource(true);
    const ov = fakeSource(true);
    const composition = comp({
      scenes: [],
      overlays: [
        { id: "s1", kind: "video", fileId: "f1", videoUrl: "/x", startTime: 0, duration: 10, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 1920, height: 1080 } } as never,
        {
          id: "ov1",
          kind: "video",
          fileId: "f2",
          startTime: 0,
          duration: 10,
          z: 0,
          rect: { x: 0, y: 0, w: 100, h: 100 },
        } as never,
      ],
    });
    const map = new Map([
      ["s1", { source: base.source }],
      ["ov1", { source: ov.source }],
    ]);
    hardSeekAllSources(composition, 4, map);
    expect(base.hardSeek).toHaveBeenCalledWith(4);
    expect(ov.hardSeek).toHaveBeenCalledWith(4);
  });
});
