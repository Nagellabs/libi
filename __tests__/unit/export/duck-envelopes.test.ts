import { describe, it, expect } from "vitest";
import { placeOnTimeline, type PlacedSidechain } from "@/lib/export/duck-envelopes";

/**
 * `placeOnTimeline` is the export's half of the duck: it puts each sidechain
 * clip where it actually plays before `duckGainCurve` reads it. With several
 * sidechains it must SUM them into one mono buffer — not average them, and not
 * produce one curve per clip to be multiplied together, which would double-duck
 * wherever two voices overlap.
 */

const SR = 100; // small and exact — every boundary below lands on a sample

const clip = (over: Partial<PlacedSidechain> = {}): PlacedSidechain => ({
  path: "/x.wav",
  startTime: 0,
  trimStart: 0,
  duration: 1,
  volume: 1,
  ...over,
});

describe("placeOnTimeline", () => {
  it("places a clip at its start time and leaves the rest silent", () => {
    const decoded = new Float32Array(100).fill(0.5);
    const t = placeOnTimeline(decoded, clip({ startTime: 1, duration: 1 }), 300, SR);
    expect(t[50]).toBe(0);        // before
    expect(t[150]).toBe(0.5);     // during
    expect(t[250]).toBe(0);       // after
  });

  it("honours trimStart, duration and volume", () => {
    const decoded = new Float32Array(200);
    for (let i = 0; i < 200; i++) decoded[i] = i / 200;
    const t = placeOnTimeline(decoded, clip({ startTime: 0, trimStart: 1, duration: 0.5, volume: 0.5 }), 300, SR);
    expect(t[0]).toBeCloseTo(decoded[100] * 0.5, 6);
    expect(t[49]).toBeCloseTo(decoded[149] * 0.5, 6);
    expect(t[50]).toBe(0); // past `duration`
  });

  it("accumulates into a shared buffer instead of overwriting it", () => {
    const a = new Float32Array(100).fill(0.4);
    const b = new Float32Array(100).fill(0.3);
    const timeline = new Float32Array(300);
    placeOnTimeline(a, clip({ startTime: 0 }), 300, SR, timeline);
    placeOnTimeline(b, clip({ startTime: 2 }), 300, SR, timeline);
    expect(timeline[50]).toBeCloseTo(0.4, 6);
    expect(timeline[150]).toBe(0);   // the gap between the two voices
    expect(timeline[250]).toBeCloseTo(0.3, 6);
  });

  it("sums overlapping sidechains rather than replacing them", () => {
    const a = new Float32Array(100).fill(0.4);
    const b = new Float32Array(100).fill(0.3);
    const timeline = new Float32Array(200);
    placeOnTimeline(a, clip({ startTime: 0 }), 200, SR, timeline);
    placeOnTimeline(b, clip({ startTime: 0.5 }), 200, SR, timeline);
    expect(timeline[25]).toBeCloseTo(0.4, 6);
    expect(timeline[75]).toBeCloseTo(0.7, 6); // both speaking
    expect(timeline[125]).toBeCloseTo(0.3, 6);
  });

  it("still returns a fresh zeroed buffer when none is passed", () => {
    const decoded = new Float32Array(100).fill(1);
    const t = placeOnTimeline(decoded, clip({ startTime: 1 }), 300, SR);
    expect(t.length).toBe(300);
    expect(t[0]).toBe(0);
  });
});
