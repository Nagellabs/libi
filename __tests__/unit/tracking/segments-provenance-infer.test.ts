import { describe, it, expect } from "vitest";
import { normalizeTrack } from "@/lib/tracking/segments";
import type { Track } from "@/lib/tracking/types";

function s(t: number) {
  return { t, x: 0, y: 0, w: 10, h: 10, confidence: 1, visible: true };
}

describe("normalizeTrack infers provenance for untagged legacy segments", () => {
  const track: Track = {
    id: "trk", fileId: "f", method: "yoloe+botsort", framerate: 30,
    durationSec: 6, samples: [],
    manualAnchors: [{ id: "man-3933", time: 3.933, bbox: [1, 2, 3, 4] }],
    segments: [
      // full-range engine seed
      { id: "seg-0-6000", startTime: 0, endTime: 6, method: "yoloe+botsort",
        status: "ok", samples: [s(0), s(6)] },
      // wide segment that CONTAINS the manual anchor time ⇒ manual
      { id: "seg-933-6933", startTime: 0.93, endTime: 6.93, method: "yoloe+botsort",
        status: "ok", samples: [s(1)] },
      // narrow segment with no anchor inside ⇒ agent
      { id: "seg-2000-3000", startTime: 2, endTime: 3, method: "yoloe+botsort",
        status: "ok", samples: [s(2.5)] },
    ],
  };

  it("tags full-range as engine, manual-anchor-containing as manual, else agent", () => {
    const n = normalizeTrack(track);
    const byId = Object.fromEntries(n.segments!.map((g) => [g.id, g.provenance]));
    expect(byId["seg-0-6000"]).toBe("engine");
    expect(byId["seg-933-6933"]).toBe("manual");
    expect(byId["seg-2000-3000"]).toBe("agent");
  });

  it("does not overwrite an explicit provenance", () => {
    const explicit = normalizeTrack({
      ...track,
      segments: [{ ...track.segments![2], provenance: "engine" }],
    });
    expect(explicit.segments![0].provenance).toBe("engine");
  });

  it("does not throw or produce Infinity when ALL segments have empty samples", () => {
    // Regression: inferSegmentProvenance computed Math.min(...[]) === Infinity
    // when allT was empty. Guard: `allT.length ? Math.min(...allT) : 0`.
    const allEmptyTrack: Track = {
      id: "trk-empty", fileId: "f", method: "yoloe+botsort", framerate: 30,
      durationSec: 5, samples: [],
      segments: [
        // Two skipped segments, both with no samples.
        { id: "seg-2000-3000", startTime: 2, endTime: 3, method: "yoloe+botsort",
          status: "skipped", samples: [], reason: "subject not visible" },
        { id: "seg-4000-5000", startTime: 4, endTime: 5, method: "yoloe+botsort",
          status: "skipped", samples: [], reason: "occlusion" },
      ],
    };

    // Must not throw.
    let n: Track;
    expect(() => { n = normalizeTrack(allEmptyTrack); }).not.toThrow();
    n = normalizeTrack(allEmptyTrack);

    // Neither segment spans [0, 0] (the degenerate lo===hi===0 guard maps
    // everything to "engine" when isFullRange is trivially true for any
    // startTime<=0). Both have no anchors inside, so both get "agent".
    const byId = Object.fromEntries(n.segments!.map((g) => [g.id, g.provenance]));
    expect(byId["seg-2000-3000"]).toBe("agent");
    expect(byId["seg-4000-5000"]).toBe("agent");

    // Derived samples should be empty (no data), not Infinity-containing.
    expect(n.samples).toEqual([]);
  });

  it("mixed empty+non-empty segments: engine tagged for full-range, agent for empty skipped", () => {
    // Mixed case: one full-range engine segment with real samples + one empty
    // skipped segment. The guard must not let the empty segment's absence
    // pollute lo/hi so the full-range segment is tagged correctly.
    const mixedTrack: Track = {
      id: "trk-mixed", fileId: "f", method: "yoloe+botsort", framerate: 30,
      durationSec: 6, samples: [],
      segments: [
        { id: "seg-0-6000", startTime: 0, endTime: 6, method: "yoloe+botsort",
          status: "ok", samples: [s(0), s(6)] },
        { id: "seg-2000-3000", startTime: 2, endTime: 3, method: "yoloe+botsort",
          status: "skipped", samples: [], reason: "occlusion" },
      ],
    };

    let n: Track;
    expect(() => { n = normalizeTrack(mixedTrack); }).not.toThrow();
    n = normalizeTrack(mixedTrack);

    const byId = Object.fromEntries(n.segments!.map((g) => [g.id, g.provenance]));
    // Full-range segment (covers lo=0 to hi=6) ⇒ engine.
    expect(byId["seg-0-6000"]).toBe("engine");
    // Empty skipped segment not full-range, no manual anchor ⇒ agent.
    expect(byId["seg-2000-3000"]).toBe("agent");

    // Sanity: no Infinity in the derived samples' t values.
    const hasInfinity = n.samples.some((p) => !isFinite(p.t));
    expect(hasInfinity).toBe(false);
  });
});
