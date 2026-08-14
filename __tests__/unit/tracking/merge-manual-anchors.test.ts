import { describe, it, expect } from "vitest";
import { mergeManualAnchorsIntoTrack } from "@/lib/tracking/manual-anchors";
import { sampleTrack } from "@/lib/tracking/sample";
import type { Track } from "@/lib/tracking/types";

function mk(t: number, x: number): { t: number; x: number; y: number; w: number; h: number; confidence: number; visible: boolean } {
  return { t, x, y: 0, w: 10, h: 10, confidence: 1, visible: true };
}

describe("mergeManualAnchorsIntoTrack", () => {
  it("pins exactly at the anchor time and drops near-duplicate derived samples", () => {
    const track: Track = {
      id: "t", fileId: "f", method: "yoloe+botsort", framerate: 10, durationSec: 1,
      samples: [mk(0, 0), mk(0.5, 50), mk(1, 100)],
      segments: [{ id: "seg-0-1000", startTime: 0, endTime: 1, method: "yoloe+botsort", status: "ok",
        samples: [mk(0, 0), mk(0.5, 50), mk(1, 100)] }],
      manualAnchors: [{ id: "man-500", time: 0.5, bbox: [999, 7, 8, 9] }],
    };
    const merged = mergeManualAnchorsIntoTrack(track);
    const at = sampleTrack(merged, 0.5, "linear");
    expect(at?.x).toBe(999);
    expect(at?.visible).toBe(true);
    // endpoints untouched
    expect(sampleTrack(merged, 0, "linear")?.x).toBe(0);
    expect(sampleTrack(merged, 1, "linear")?.x).toBe(100);
  });

  it("no manualAnchors → identical samples reference-safe", () => {
    const track: Track = {
      id: "t", fileId: "f", method: "yoloe+botsort", framerate: 10, durationSec: 1,
      samples: [mk(0, 0)], segments: [{ id: "s", startTime: 0, endTime: 1, method: "yoloe+botsort", status: "ok", samples: [mk(0, 0)] }],
    };
    expect(mergeManualAnchorsIntoTrack(track).samples).toEqual(track.samples);
  });

  it("skipped/lost segment is NOT injected", () => {
    const skippedSeg = { id: "s-skip", startTime: 1, endTime: 2, method: "skip" as const, status: "skipped" as const, samples: [] as ReturnType<typeof mk>[] };
    const track: Track = {
      id: "t", fileId: "f", method: "yoloe+botsort", framerate: 10, durationSec: 2,
      samples: [mk(0, 0), mk(1, 100)],
      segments: [
        { id: "s-ok", startTime: 0, endTime: 1, method: "yoloe+botsort", status: "ok", samples: [mk(0, 0), mk(1, 100)] },
        skippedSeg,
      ],
      // 10×10 = the track sample size, so F2 anchor size-reconciliation is a
      // no-op here — this asserts segment routing, not size.
      manualAnchors: [{ id: "man-1500", time: 1.5, bbox: [888, 0, 10, 10] }],
    };
    const merged = mergeManualAnchorsIntoTrack(track);
    // Skipped segment must be the same object reference — not touched at all
    expect(merged.segments![1]).toBe(track.segments![1]);
    expect(merged.segments![1].samples).toEqual([]);
    // Top-level samples DO contain the injected anchor
    expect(merged.samples.some((s) => s.x === 888)).toBe(true);
  });

  it("multiple anchors across multiple OK segments inject independently", () => {
    const track: Track = {
      id: "t", fileId: "f", method: "yoloe+botsort", framerate: 10, durationSec: 2,
      samples: [mk(0, 0), mk(1, 10), mk(1.0001, 10), mk(2, 20)],
      segments: [
        { id: "a", startTime: 0, endTime: 1, method: "yoloe+botsort", status: "ok", samples: [mk(0, 0), mk(1, 10)] },
        { id: "b", startTime: 1, endTime: 2, method: "yoloe+botsort", status: "ok", samples: [mk(1.0001, 10), mk(2, 20)] },
      ],
      manualAnchors: [
        { id: "man-500", time: 0.5, bbox: [111, 0, 10, 10] },
        { id: "man-1500", time: 1.5, bbox: [222, 0, 10, 10] },
      ],
    };
    const merged = mergeManualAnchorsIntoTrack(track);
    // Segment "a" gets the 111 anchor, NOT the 222 one
    expect(merged.segments![0].samples.some((s) => s.x === 111)).toBe(true);
    expect(merged.segments![0].samples.some((s) => s.x === 222)).toBe(false);
    // Segment "b" gets the 222 anchor, NOT the 111 one
    expect(merged.segments![1].samples.some((s) => s.x === 222)).toBe(true);
    expect(merged.segments![1].samples.some((s) => s.x === 111)).toBe(false);
  });

  it("anchor outside all segments still injects into top-level samples", () => {
    const track: Track = {
      id: "t", fileId: "f", method: "yoloe+botsort", framerate: 10, durationSec: 1,
      samples: [mk(0, 0), mk(1, 100)],
      segments: [],
      manualAnchors: [{ id: "man-500", time: 0.5, bbox: [777, 0, 10, 10] }],
    };
    const merged = mergeManualAnchorsIntoTrack(track);
    expect(sampleTrack(merged, 0.5, "linear")?.x).toBe(777);
    expect(merged.segments).toEqual([]);
  });
});
