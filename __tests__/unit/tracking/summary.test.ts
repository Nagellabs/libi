import { describe, it, expect } from "vitest";
import { summarizeTrack } from "@/lib/tracking/summary";
import { normalizeTrack } from "@/lib/tracking/segments";
import type { Track } from "@/lib/tracking/types";

const track: Track = normalizeTrack({
  id: "trk", fileId: "f", method: "sam2-fal", framerate: 1, durationSec: 4,
  samples: [
    { t: 0, x: 0, y: 0, w: 607, h: 1079, confidence: 1, visible: true },
    { t: 1, x: 10, y: 10, w: 20, h: 20, confidence: 0.9, visible: true },
    { t: 2, x: 12, y: 12, w: 20, h: 20, confidence: 0.9, visible: true },
    { t: 3, x: 0, y: 0, w: 0, h: 0, confidence: 0, visible: false },
  ],
});

describe("summarizeTrack", () => {
  it("reports counts, visible/lost ranges and flags the full-canvas-while-visible case", () => {
    const sum = summarizeTrack(track, { frameW: 608, frameH: 1080, clipDurationSec: 38.5 });
    expect(sum.total).toBe(4);
    expect(sum.visible).toBe(2);
    expect(sum.visibleRanges).toEqual([{ start: 1, end: 2 }]);
    expect(sum.lostRanges).toEqual([{ start: 3, end: 3 }]);
    expect(sum.flags).toContain("full_canvas_while_visible");
    expect(sum.perSegment).toHaveLength(1);
  });
});
