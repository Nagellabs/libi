import { describe, it, expect } from "vitest";
import { normalizeTrack, deriveSamples } from "@/lib/tracking/segments";
import type { Track } from "@/lib/tracking/types";

const legacy: Track = {
  id: "trk-1", fileId: "f1", method: "sam2-fal", framerate: 30, durationSec: 2,
  samples: [
    { t: 0, x: 1, y: 1, w: 10, h: 10, confidence: 1, visible: true },
    { t: 1, x: 2, y: 2, w: 10, h: 10, confidence: 1, visible: true },
    { t: 2, x: 3, y: 3, w: 10, h: 10, confidence: 0, visible: false },
  ],
};

describe("normalizeTrack", () => {
  it("wraps a legacy track into one full-range segment", () => {
    const n = normalizeTrack(legacy);
    expect(n.segments).toHaveLength(1);
    expect(n.segments![0]).toMatchObject({
      startTime: 0, endTime: 2, method: "sam2-fal", status: "ok",
    });
    expect(n.segments![0].samples).toHaveLength(3);
  });

  it("is idempotent (already-segmented track unchanged)", () => {
    const once = normalizeTrack(legacy);
    const twice = normalizeTrack(once);
    expect(twice.segments).toHaveLength(1);
    expect(deriveSamples(twice)).toHaveLength(3);
  });

  it("deriveSamples stitches segments in time order with gaps", () => {
    const seg = normalizeTrack({
      ...legacy,
      segments: [
        { id: "s2", startTime: 5, endTime: 6, method: "yoloe-visual", status: "ok",
          samples: [{ t: 5, x: 9, y: 9, w: 5, h: 5, confidence: 1, visible: true }] },
        { id: "s1", startTime: 0, endTime: 1, method: "skip", status: "skipped", samples: [] },
      ],
      samples: [],
    });
    const out = deriveSamples(seg);
    expect(out.map((s) => s.t)).toEqual([5]); // skipped seg contributes nothing
  });
});
