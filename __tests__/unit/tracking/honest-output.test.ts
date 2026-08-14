import { describe, it, expect } from "vitest";
import { sanitizeSamples } from "@/lib/tracking/honest-output";
import type { TrackSample } from "@/lib/tracking/types";

const frame = { w: 608, h: 1080 };

describe("sanitizeSamples", () => {
  it("forces visible:false when bbox ~= full canvas (the SAM2 collapse)", () => {
    const s: TrackSample[] = [
      { t: 0, x: 0, y: 0, w: 607, h: 1079, confidence: 1, visible: true },
      { t: 1, x: 100, y: 200, w: 80, h: 90, confidence: 0.9, visible: true },
    ];
    const out = sanitizeSamples(s, { frameW: frame.w, frameH: frame.h, clipDurationSec: 38.5 });
    expect(out[0].visible).toBe(false);
    expect(out[0].confidence).toBe(0);
    expect(out[1].visible).toBe(true);
  });

  it("drops samples whose t exceeds clip duration (the 0-70s-for-38.5s bug)", () => {
    const s: TrackSample[] = [
      { t: 10, x: 1, y: 1, w: 5, h: 5, confidence: 1, visible: true },
      { t: 70, x: 1, y: 1, w: 5, h: 5, confidence: 1, visible: true },
    ];
    const out = sanitizeSamples(s, { frameW: frame.w, frameH: frame.h, clipDurationSec: 38.5 });
    expect(out.map((x) => x.t)).toEqual([10]);
  });
});
