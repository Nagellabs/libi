import { describe, it, expect } from "vitest";
import { deriveSamples } from "@/lib/tracking/segments";
import type { Track } from "@/lib/tracking/types";

function s(t: number, x: number, vis = true) {
  return { t, x, y: 0, w: 10, h: 10, confidence: vis ? 1 : 0, visible: vis };
}

const base: Omit<Track, "segments"> = {
  id: "trk", fileId: "f", method: "yoloe+botsort", framerate: 30,
  durationSec: 3, samples: [],
};

describe("deriveSamples precedence: provenance > recency > span", () => {
  it("a wider manual segment wins its overlap over a narrower older agent segment", () => {
    const track: Track = {
      ...base,
      segments: [
        { id: "engine-wide", startTime: 0, endTime: 3, method: "yoloe+botsort",
          status: "ok", provenance: "engine", createdAt: 1,
          samples: [s(1, 1), s(2, 1)] },
        { id: "agent-narrow", startTime: 1.5, endTime: 2.5, method: "yoloe+botsort",
          status: "ok", provenance: "agent", createdAt: 2,
          samples: [s(2, 99)] }, // bad cameraman x
        { id: "manual-wide", startTime: 1, endTime: 3, method: "yoloe+botsort",
          status: "ok", provenance: "manual", createdAt: 3,
          samples: [s(2, 7)] }, // user's correct x
      ],
    };
    const out = deriveSamples(track);
    const at2 = out.find((p) => p.t === 2)!;
    expect(at2.x).toBe(7); // manual wins, NOT 99 (agent) or 1 (engine)
  });

  it("a narrower agent carve-out still overrides the wide engine seed (composable semantics preserved)", () => {
    const track: Track = {
      ...base,
      segments: [
        { id: "engine-wide", startTime: 0, endTime: 3, method: "yoloe+botsort",
          status: "ok", provenance: "engine", createdAt: 1,
          samples: [s(1, 1), s(2, 1)] },
        { id: "agent-narrow", startTime: 1.5, endTime: 2.5, method: "yoloe+botsort",
          status: "ok", provenance: "agent", createdAt: 2,
          samples: [s(2, 5)] },
      ],
    };
    expect(deriveSamples(track).find((p) => p.t === 2)!.x).toBe(5);
  });

  it("absent provenance is treated as engine (back-compat) and span breaks ties", () => {
    const track: Track = {
      ...base,
      segments: [
        { id: "wide", startTime: 0, endTime: 3, method: "yoloe+botsort",
          status: "ok", samples: [s(1, 1), s(2, 1)] },
        { id: "narrow", startTime: 1.5, endTime: 2.5, method: "yoloe+botsort",
          status: "ok", samples: [s(2, 9)] },
      ],
    };
    expect(deriveSamples(track).find((p) => p.t === 2)!.x).toBe(9);
  });

  it("non-overlapping shot fan-out is unchanged", () => {
    const track: Track = {
      ...base,
      segments: [
        { id: "shot-b", startTime: 2, endTime: 3, method: "yoloe+botsort",
          status: "ok", provenance: "engine", createdAt: 2, samples: [s(2.5, 2)] },
        { id: "shot-a", startTime: 0, endTime: 1, method: "yoloe+botsort",
          status: "ok", provenance: "engine", createdAt: 1, samples: [s(0.5, 1)] },
      ],
    };
    const out = deriveSamples(track);
    expect(out.map((p) => p.t)).toEqual([0.5, 2.5]);
  });
});
