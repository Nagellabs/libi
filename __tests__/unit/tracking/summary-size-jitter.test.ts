import { describe, it, expect } from "vitest";
import { summarizeTrack } from "@/lib/tracking/summary";
import type { Track, TrackSample } from "@/lib/tracking/types";

function trk(samples: TrackSample[]): Track {
  return {
    id: "t",
    fileId: "f",
    label: "x",
    method: "m",
    framerate: 30,
    durationSec: samples.length / 30,
    samples,
    segments: [
      {
        id: "s",
        startTime: 0,
        endTime: samples.length / 30,
        method: "m",
        status: "ok",
        samples,
      },
    ],
    anchors: [],
  };
}
const steady = Array.from({ length: 60 }, (_, i) => ({
  t: i / 30,
  x: 100,
  y: 100,
  w: 80,
  h: 60,
  confidence: 1,
  visible: true,
}));

describe("size_jitter", () => {
  it("fires on a sustained >3x-median visible run (relative, not frame-absolute)", () => {
    const s = steady.map((o) => ({ ...o }));
    for (let i = 20; i < 40; i++)
      s[i] = { t: i / 30, x: 100, y: 100, w: 200, h: 160, confidence: 1, visible: true }; // ~6.7x area
    const sum = summarizeTrack(trk(s), { frameW: 2000, frameH: 2000, clipDurationSec: 2 });
    expect(sum.issues.some((i) => i.kind === "size_jitter")).toBe(true);
  });
  it("absent on a steady track", () => {
    const sum = summarizeTrack(trk(steady), {
      frameW: 2000,
      frameH: 2000,
      clipDurationSec: 2,
    });
    expect(sum.issues.some((i) => i.kind === "size_jitter")).toBe(false);
  });
});
