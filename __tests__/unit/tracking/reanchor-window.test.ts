import { describe, it, expect } from "vitest";
import { reanchorWindow } from "@/lib/tracking/manual-anchors";
import type { Track } from "@/lib/tracking/types";

const base: Track = {
  id: "t",
  fileId: "f",
  method: "yoloe+botsort",
  framerate: 30,
  durationSec: 38,
  samples: [],
  segments: [
    { id: "seg-0-10000", startTime: 0, endTime: 10, method: "yoloe+botsort", status: "ok", samples: [] },
    { id: "seg-10000-20000", startTime: 10, endTime: 20, method: "skip", status: "skipped", samples: [] },
  ],
};

describe("reanchorWindow", () => {
  it("bounds to ±W around the pin, never exceeding the containing OK segment", () => {
    // pin mid-segment: full ±3 window fits inside [0,10]
    expect(reanchorWindow(base, 5, 3)).toEqual({ start: 2, end: 8 });
    // pin near the segment start: clamped to the segment start (0), not -2
    expect(reanchorWindow(base, 1, 3)).toEqual({ start: 0, end: 4 });
    // pin near the segment end: clamped to the segment end (10), not 12
    expect(reanchorWindow(base, 9, 3)).toEqual({ start: 6, end: 10 });
  });

  it("skipped/lost segments are NOT treated as containing — falls back to ±W clamped to duration", () => {
    // t=15 is inside the SKIPPED segment → not containing → fallback,
    // clamped to [0, durationSec(38)]
    expect(reanchorWindow(base, 15, 3)).toEqual({ start: 12, end: 18 });
  });

  it("pin outside every OK segment uses ±W clamped to [0, durationSec]", () => {
    expect(reanchorWindow({ ...base, segments: [] }, 1, 3)).toEqual({ start: 0, end: 4 });
    expect(reanchorWindow({ ...base, segments: [] }, 37, 3)).toEqual({ start: 34, end: 38 });
  });

  it("degenerate durationSec (0) outside any OK segment falls back to time+W", () => {
    expect(reanchorWindow({ ...base, segments: [], durationSec: 0 }, 20, 3)).toEqual({
      start: 17,
      end: 23,
    });
  });
});
