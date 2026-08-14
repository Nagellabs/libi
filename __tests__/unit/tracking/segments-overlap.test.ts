import { describe, it, expect } from "vitest";
import { deriveSamples } from "@/lib/tracking/segments";
import type { Track, TrackSegment } from "@/lib/tracking/types";

function seg(
  id: string,
  start: number,
  end: number,
  ts: number[],
  status: TrackSegment["status"] = "ok",
): TrackSegment {
  return {
    id,
    startTime: start,
    endTime: end,
    method: "yoloe+botsort",
    status,
    samples: ts.map((t) => ({ t, x: t, y: t, w: 10, h: 10, confidence: 1, visible: true })),
  };
}

function trk(segments: TrackSegment[]): Track {
  return { id: "t", fileId: "f", method: "yoloe+botsort", framerate: 30, durationSec: 10, segments, samples: [] };
}

describe("deriveSamples — composable overlap override (the repair-loop bug)", () => {
  it("a narrower repaired segment REPLACES the overlapping portion of the full-clip segment (no duplicates, stale samples gone)", () => {
    // Reproduces the live Lisa case: compute_object_track laid one
    // full-clip segment; compute_track_segment then carved out 5–8 with
    // GOOD samples. The bad 5–8 samples from the wide segment must NOT
    // survive, and total must not balloon (was 11+4=15 → must be 11).
    const full = seg("seg-0-10", 0, 10, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // x=t (bad in 5..8)
    const repair: TrackSegment = {
      id: "seg-5-8",
      startTime: 5,
      endTime: 8,
      method: "sot",
      status: "ok",
      // distinctive marker so we can prove the repair won the overlap
      samples: [5, 6, 7, 8].map((t) => ({ t, x: 999, y: 999, w: 20, h: 20, confidence: 1, visible: true })),
    };
    const out = deriveSamples(trk([full, repair]));

    // No duplicate timestamps — one sample per t, total == 11 not 15.
    expect(out.map((s) => s.t)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // 5..8 come from the REPAIR (x===999), not the stale wide segment.
    for (const t of [5, 6, 7, 8]) {
      expect(out.find((s) => s.t === t)!.x).toBe(999);
    }
    // Outside the repair range, the original wide segment still owns it.
    for (const t of [0, 4, 9, 10]) {
      expect(out.find((s) => s.t === t)!.x).toBe(t);
    }
  });

  it("an empty skip segment CLEARS its overlapping range (renders nothing there)", () => {
    const full = seg("seg-0-10", 0, 10, [0, 2, 4, 6, 8, 10]);
    const skip = seg("seg-4-7", 4, 7, [], "skipped");
    const out = deriveSamples(trk([full, skip]));
    // Samples at t=4 and t=6 (inside [4,7]) must be gone.
    expect(out.map((s) => s.t)).toEqual([0, 2, 8, 10]);
  });

  it("non-overlapping shot-fanout segments still concatenate unchanged (no regression)", () => {
    const a = seg("seg-0-3", 0, 3, [0, 1, 2, 3]);
    const b = seg("seg-3-6", 3.0001, 6, [4, 5, 6]);
    const out = deriveSamples(trk([a, b]));
    expect(out.map((s) => s.t)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("order-independent: overlap result is the same regardless of segments array order", () => {
    const full = seg("seg-0-10", 0, 10, [0, 5, 10]);
    const repair = { ...seg("seg-4-6", 4, 6, [5]), method: "sot" as const };
    const ab = deriveSamples(trk([full, repair])).map((s) => `${s.t}:${s.x}`);
    const ba = deriveSamples(trk([repair, full])).map((s) => `${s.t}:${s.x}`);
    expect(ab).toEqual(ba);
  });
});
