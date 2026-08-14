import { describe, it, expect } from "vitest";
import { applyManualAnchorsToTrackMap } from "@/hooks/preview/use-overlay-tracks";
import type { Track } from "@/lib/tracking/types";

describe("applyManualAnchorsToTrackMap — agent override", () => {
  it("stamps agent anchors at render", () => {
    const track: Track = {
      id: "t1", fileId: "f", method: "yoloe+botsort", framerate: 10, durationSec: 1,
      samples: [{ t: 0.5, x: 1, y: 1, w: 1, h: 1, confidence: 1, visible: true }],
      segments: [{ id: "s", startTime: 0, endTime: 1, method: "yoloe+botsort", status: "ok",
        samples: [{ t: 0.5, x: 1, y: 1, w: 1, h: 1, confidence: 1, visible: true }] }],
      agentAnchors: [{ id: "agt-500", time: 0.5, bbox: [55, 0, 1, 1] }],
    };
    const out = applyManualAnchorsToTrackMap({ t1: track });
    expect(out.t1.samples.find((s) => s.t === 0.5)?.x).toBe(55);
  });

  it("manual wins over agent at the same time", () => {
    const track: Track = {
      id: "t2", fileId: "f", method: "yoloe+botsort", framerate: 10, durationSec: 1,
      samples: [{ t: 0.5, x: 1, y: 1, w: 1, h: 1, confidence: 1, visible: true }],
      segments: [{ id: "s", startTime: 0, endTime: 1, method: "yoloe+botsort", status: "ok",
        samples: [{ t: 0.5, x: 1, y: 1, w: 1, h: 1, confidence: 1, visible: true }] }],
      agentAnchors: [{ id: "agt-500", time: 0.5, bbox: [55, 0, 1, 1] }],
      manualAnchors: [{ id: "man-500", time: 0.5, bbox: [42, 0, 1, 1] }],
    };
    expect(applyManualAnchorsToTrackMap({ t2: track }).t2.samples.find((s) => s.t === 0.5)?.x).toBe(42);
  });
});
