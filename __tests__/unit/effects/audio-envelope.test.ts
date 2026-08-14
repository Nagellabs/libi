import { describe, it, expect } from "vitest";
import { audioGainAt } from "@/lib/effects/audio-envelope";

describe("audioGainAt", () => {
  const clip = { startTime: 0, duration: 4, effects: { in: { effectId: "audio-fade-in", durationMs: 1000 }, out: { effectId: "audio-fade-out", durationMs: 1000 } } };
  it("is 0 at clip start, 1 mid, 0 at end for in+out fades", () => {
    expect(audioGainAt(clip, 0)).toBeCloseTo(0, 5);
    expect(audioGainAt(clip, 2)).toBeCloseTo(1, 5);
    expect(audioGainAt(clip, 4)).toBeCloseTo(0, 5);
  });
  it("is 1 everywhere with no effects", () => {
    expect(audioGainAt({ startTime: 0, duration: 4 }, 2)).toBeCloseTo(1, 5);
  });
});
