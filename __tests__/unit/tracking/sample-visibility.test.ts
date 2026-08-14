import { describe, it, expect } from "vitest";
import { sampleTrack } from "@/lib/tracking/sample";
import type { Track, TrackSample } from "@/lib/tracking/types";

const baseTrack = (samples: TrackSample[]): Track => ({
  id: "t",
  fileId: "f",
  method: "mediapipe-face",
  framerate: 30,
  durationSec: samples.at(-1)?.t ?? 0,
  samples,
});

describe("sampleTrack visibility", () => {
  it("returns visible only when BOTH bracket ends are visible", () => {
    const track = baseTrack([
      { t: 0, x: 0, y: 0, w: 0, h: 0, confidence: 0, visible: false },
      { t: 1, x: 100, y: 100, w: 50, h: 50, confidence: 0.9, visible: true },
      { t: 2, x: 120, y: 110, w: 50, h: 50, confidence: 0.9, visible: true },
      { t: 3, x: 120, y: 110, w: 50, h: 50, confidence: 0, visible: false },
    ]);
    expect(sampleTrack(track, 0.5, "linear")?.visible).toBe(false);
    expect(sampleTrack(track, 1.5, "linear")?.visible).toBe(true);
    expect(sampleTrack(track, 2.5, "linear")?.visible).toBe(false);
  });

  it("returns null outside the range", () => {
    const track = baseTrack([
      { t: 1, x: 0, y: 0, w: 10, h: 10, confidence: 0.9, visible: true },
      { t: 2, x: 0, y: 0, w: 10, h: 10, confidence: 0.9, visible: true },
    ]);
    expect(sampleTrack(track, 0.5, "linear")).toBeNull();
    expect(sampleTrack(track, 3, "linear")).toBeNull();
  });
});
