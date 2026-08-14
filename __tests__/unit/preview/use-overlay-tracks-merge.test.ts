import { describe, it, expect } from "vitest";
import { applyManualAnchorsToTrackMap } from "@/hooks/preview/use-overlay-tracks";
import type { Track } from "@/lib/tracking/types";

describe("applyManualAnchorsToTrackMap", () => {
  it("merges manual anchors into each track in the map", () => {
    const track: Track = {
      id: "t1", fileId: "f", method: "yoloe+botsort", framerate: 10, durationSec: 1,
      samples: [{ t: 0.5, x: 1, y: 1, w: 1, h: 1, confidence: 1, visible: true }],
      segments: [{ id: "s", startTime: 0, endTime: 1, method: "yoloe+botsort", status: "ok",
        samples: [{ t: 0.5, x: 1, y: 1, w: 1, h: 1, confidence: 1, visible: true }] }],
      manualAnchors: [{ id: "man-500", time: 0.5, bbox: [42, 0, 1, 1] }],
    };
    const out = applyManualAnchorsToTrackMap({ t1: track });
    expect(out.t1.samples.find((s) => s.t === 0.5)?.x).toBe(42);
  });

  it("merges anchored tracks but passes no-anchor tracks through by reference", () => {
    const anchored: Track = {
      id: "a", fileId: "f", method: "yoloe+botsort", framerate: 10, durationSec: 1,
      samples: [{ t: 0.5, x: 1, y: 1, w: 1, h: 1, confidence: 1, visible: true }],
      segments: [{ id: "s", startTime: 0, endTime: 1, method: "yoloe+botsort", status: "ok",
        samples: [{ t: 0.5, x: 1, y: 1, w: 1, h: 1, confidence: 1, visible: true }] }],
      manualAnchors: [{ id: "man-500", time: 0.5, bbox: [42, 0, 1, 1] }],
    };
    const plain: Track = {
      id: "b", fileId: "f", method: "yoloe+botsort", framerate: 10, durationSec: 1,
      samples: [{ t: 0.5, x: 7, y: 7, w: 7, h: 7, confidence: 1, visible: true }],
      segments: [{ id: "s", startTime: 0, endTime: 1, method: "yoloe+botsort", status: "ok",
        samples: [{ t: 0.5, x: 7, y: 7, w: 7, h: 7, confidence: 1, visible: true }] }],
    };
    const out = applyManualAnchorsToTrackMap({ a: anchored, b: plain });
    // anchored track: merged (pinned sample present)
    expect(out.a.samples.find((s) => s.t === 0.5)?.x).toBe(42);
    // no-anchor track: SAME reference (identity-stability contract consumers rely on)
    expect(out.b).toBe(plain);
  });
});
