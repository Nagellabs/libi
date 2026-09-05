import { describe, it, expect } from "vitest";
import { pieceDurationSec } from "@/lib/composition/duration";

describe("pieceDurationSec", () => {
  it("is 0 for an empty manifest", () => {
    expect(pieceDurationSec({})).toBe(0);
    expect(pieceDurationSec({ overlays: [], audioClips: [] })).toBe(0);
  });

  it("takes the furthest overlay end", () => {
    const m = { overlays: [
      { startTime: 0, duration: 3 },
      { startTime: 5, duration: 2 },
    ] } as never;
    expect(pieceDurationSec(m)).toBe(7);
  });

  it("takes the furthest audio clip end", () => {
    const m = { audioClips: [{ startTime: 1, duration: 9 }] } as never;
    expect(pieceDurationSec(m)).toBe(10);
  });

  it("takes the max across BOTH lists", () => {
    const m = {
      overlays: [{ startTime: 0, duration: 3 }],
      audioClips: [{ startTime: 0, duration: 229 }],
    } as never;
    expect(pieceDurationSec(m)).toBe(229);
  });

  it("treats missing startTime/duration as 0 rather than NaN", () => {
    const m = { overlays: [{}, { startTime: 4 }, { duration: 2 }] } as never;
    expect(pieceDurationSec(m)).toBe(4);
  });
});
