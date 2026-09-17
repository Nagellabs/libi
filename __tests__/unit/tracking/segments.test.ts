import { describe, it, expect } from "vitest";
import { normalizeTrack, deriveSamples } from "@/lib/tracking/segments";
import type { Track } from "@/lib/tracking/types";

const legacy: Track = {
  id: "trk-1", fileId: "f1", method: "yoloe+botsort", framerate: 30, durationSec: 2,
  samples: [
    { t: 0, x: 1, y: 1, w: 10, h: 10, confidence: 1, visible: true },
    { t: 1, x: 2, y: 2, w: 10, h: 10, confidence: 1, visible: true },
    { t: 2, x: 3, y: 3, w: 10, h: 10, confidence: 0, visible: false },
  ],
};

describe("normalizeTrack", () => {
  it("wraps a legacy track into one full-range segment", () => {
    const n = normalizeTrack(legacy);
    expect(n.segments).toHaveLength(1);
    expect(n.segments![0]).toMatchObject({
      startTime: 0, endTime: 2, method: "yoloe+botsort", status: "ok",
    });
    expect(n.segments![0].samples).toHaveLength(3);
  });

  it("is idempotent (already-segmented track unchanged)", () => {
    const once = normalizeTrack(legacy);
    const twice = normalizeTrack(once);
    expect(twice.segments).toHaveLength(1);
    expect(deriveSamples(twice)).toHaveLength(3);
  });

  it("deriveSamples stitches segments in time order with gaps", () => {
    const seg = normalizeTrack({
      ...legacy,
      segments: [
        { id: "s2", startTime: 5, endTime: 6, method: "yoloe-visual", status: "ok",
          samples: [{ t: 5, x: 9, y: 9, w: 5, h: 5, confidence: 1, visible: true }] },
        { id: "s1", startTime: 0, endTime: 1, method: "skip", status: "skipped", samples: [] },
      ],
      samples: [],
    });
    const out = deriveSamples(seg);
    expect(out.map((s) => s.t)).toEqual([5]); // skipped seg contributes nothing
  });
});

/**
 * `TrackMethod` is `… | (string & {})` — deliberately open, so a
 * third-party tracker registering results through
 * `libi.update_track_result` can name itself. The segments layer is where
 * that openness has to survive: it copies `track.method` onto the wrapped
 * segment and stitches by time and provenance ONLY. Nothing here may
 * recognise, normalise, or filter by a method it does not know, and until
 * now every fixture in this file used one of libi's own three.
 */
describe("third-party tracker methods (external-mcp:)", () => {
  const EXTERNAL = "external-mcp:my-tracker";

  it("carries an unknown method verbatim onto the wrapped legacy segment", () => {
    const n = normalizeTrack({ ...legacy, method: EXTERNAL });
    expect(n.segments).toHaveLength(1);
    // Exactly the string the third party sent — not coerced to a default,
    // not prefixed, not dropped.
    expect(n.segments![0].method).toBe(EXTERNAL);
    expect(n.segments![0].status).toBe("ok");
    expect(deriveSamples(n)).toHaveLength(3);
  });

  it("stitches an unknown-method segment alongside libi's own, by time not by method", () => {
    const track = normalizeTrack({
      ...legacy,
      segments: [
        { id: "s-engine", startTime: 0, endTime: 1, method: "yoloe+botsort", status: "ok",
          samples: [{ t: 0, x: 1, y: 1, w: 5, h: 5, confidence: 1, visible: true }] },
        { id: "s-ext", startTime: 2, endTime: 3, method: EXTERNAL, status: "ok",
          samples: [{ t: 3, x: 9, y: 9, w: 5, h: 5, confidence: 1, visible: true }] },
      ],
      samples: [],
    });
    expect(deriveSamples(track).map((s) => s.t)).toEqual([0, 3]);
    expect(track.segments!.map((g) => g.method)).toEqual(["yoloe+botsort", EXTERNAL]);
  });

  it("lets an unknown-method segment win an overlap on provenance alone", () => {
    // The precedence rules are provenance/recency/span — a segment from a
    // tracker libi has never heard of must be able to override the engine
    // seed exactly as an agent carve-out does.
    const track = normalizeTrack({
      ...legacy,
      segments: [
        { id: "s-seed", startTime: 0, endTime: 2, method: "yoloe+botsort", status: "ok",
          provenance: "engine",
          samples: [{ t: 1, x: 1, y: 1, w: 5, h: 5, confidence: 1, visible: true }] },
        { id: "s-ext", startTime: 0.5, endTime: 1.5, method: EXTERNAL, status: "ok",
          provenance: "agent",
          samples: [{ t: 1, x: 42, y: 42, w: 5, h: 5, confidence: 1, visible: true }] },
      ],
      samples: [],
    });
    const out = deriveSamples(track);
    expect(out).toHaveLength(1);
    expect(out[0].x).toBe(42);
  });
});
