import { describe, it, expect } from "vitest";
import {
  isManualAnchorConsumed,
  mergeManualAnchorsIntoTrack,
  mergeAnchorOverridesIntoTrack,
} from "@/lib/tracking/manual-anchors";
import { sampleTrack } from "@/lib/tracking/sample";
import type { Track, TrackSample } from "@/lib/tracking/types";
import type { TrackSegment } from "@/lib/tracking/segments";

// ── The trk-e6ca747d jump, in miniature ──────────────────────────────────────
//
// A manual re-anchor fires a bounded seeded re-track that writes a
// provenance:"manual" segment. The engine (gated by rejectWrongSubjectRuns +
// rejectAnchorInconsistentBoxes, tolerance 1.5× anchor size) is free to settle
// on the detector-accurate box NEAR the pin rather than exactly ON it. The
// render-time override then re-stamped the raw pin verbatim with ZERO
// tolerance — sampleTrack eases into it over ±1 frame → a 1-2 frame spike at
// exactly the re-anchor moment (270px on the real clip). A pin whose seeded
// re-track has landed is CONSUMED: the manual segment is its truth; the stamp
// must skip it. An unconsumed pin (fresh drag awaiting its re-track, or a
// re-track that bailed) still stamps — that's the optimistic snap + the
// engine-failed override.

function smoothSamples(t0: number, t1: number, fps = 30): TrackSample[] {
  const out: TrackSample[] = [];
  for (let t = t0; t <= t1 + 1e-9; t += 1 / fps) {
    out.push({
      t: Number(t.toFixed(4)),
      x: 400 - t, // gently drifting, ~1px/frame — a "good" track
      y: 280,
      w: 210,
      h: 660,
      confidence: 1,
      visible: true,
    });
  }
  return out;
}

function manualSeg(
  startTime: number,
  endTime: number,
  createdAt: number,
  extra: Partial<TrackSegment> = {},
): TrackSegment {
  return {
    id: `seg-${Math.round(startTime * 1000)}-${Math.round(endTime * 1000)}`,
    startTime,
    endTime,
    method: "yoloe+botsort",
    status: "ok",
    provenance: "manual",
    createdAt,
    samples: smoothSamples(startTime, endTime),
    ...extra,
  };
}

/** Displaced pin — like the real one: same size as the track box, center
 *  ~270px away from where the accepted re-track put the subject. */
const displacedPin = (
  time: number,
  createdAt?: number,
): { id: string; time: number; bbox: [number, number, number, number]; createdAt?: number } => ({
  id: `man-${Math.round(time * 1000)}`,
  time,
  bbox: [305, 538, 210, 660],
  ...(createdAt !== undefined ? { createdAt } : {}),
});

function trk(extra: Partial<Track>): Track {
  return {
    id: "t",
    fileId: "f",
    method: "yoloe+botsort",
    framerate: 30,
    durationSec: 20,
    samples: smoothSamples(0, 20),
    segments: [],
    ...extra,
  } as Track;
}

describe("isManualAnchorConsumed", () => {
  it("legacy anchor (no createdAt) covered by a manual OK segment → consumed", () => {
    const t = trk({ segments: [manualSeg(7.6, 13.6, 1000)] });
    expect(isManualAnchorConsumed(t, displacedPin(10.6))).toBe(true);
  });

  it("anchor NEWER than every covering manual segment → NOT consumed (re-track pending)", () => {
    const t = trk({ segments: [manualSeg(7.6, 13.6, 1000)] });
    expect(isManualAnchorConsumed(t, displacedPin(10.6, 2000))).toBe(false);
  });

  it("anchor older than the covering manual segment → consumed", () => {
    const t = trk({ segments: [manualSeg(7.6, 13.6, 3000)] });
    expect(isManualAnchorConsumed(t, displacedPin(10.6, 2000))).toBe(true);
  });

  it("covering segment is engine/agent provenance → NOT consumed", () => {
    const t = trk({
      segments: [
        manualSeg(7.6, 13.6, 3000, { provenance: "engine" }),
        manualSeg(7.6, 13.6, 3000, { provenance: "agent" }),
      ],
    });
    expect(isManualAnchorConsumed(t, displacedPin(10.6))).toBe(false);
  });

  it("covering manual segment is lost/skipped → NOT consumed", () => {
    const t = trk({
      segments: [manualSeg(7.6, 13.6, 3000, { status: "lost", samples: [] })],
    });
    expect(isManualAnchorConsumed(t, displacedPin(10.6))).toBe(false);
  });

  it("anchor outside the manual segment's window → NOT consumed", () => {
    const t = trk({ segments: [manualSeg(7.6, 13.6, 3000)] });
    expect(isManualAnchorConsumed(t, displacedPin(15.0))).toBe(false);
  });

  it("manual segment has no visible sample at the pin time → NOT consumed", () => {
    const seg = manualSeg(7.6, 13.6, 3000);
    seg.samples = seg.samples.map((s) =>
      Math.abs(s.t - 10.6) < 0.02 ? { ...s, visible: false, confidence: 0 } : s,
    );
    const t = trk({ segments: [seg] });
    expect(isManualAnchorConsumed(t, displacedPin(10.6))).toBe(false);
  });
});

describe("merge skips consumed manual anchors (the re-anchor jump fix)", () => {
  it("consumed pin is NOT stamped — no discontinuity at the re-anchor moment", () => {
    const seg = manualSeg(7.6, 13.6, 1000);
    const t = trk({
      samples: seg.samples.map((s) => ({ ...s })),
      segments: [seg],
      manualAnchors: [displacedPin(10.6)],
    });
    const merged = mergeManualAnchorsIntoTrack(t);
    // Same ref — nothing injected (memoization contract preserved).
    expect(merged).toBe(t);
    // And the render sample at the pin time is the segment's box, not the pin.
    const at = sampleTrack(merged, 10.6, "linear")!;
    expect(Math.abs(at.y - 280)).toBeLessThan(2);
    // Frame-to-frame render continuity around the pin stays tight.
    let prev = sampleTrack(merged, 10.5, "linear")!;
    for (let time = 10.5333; time <= 10.7; time += 1 / 30) {
      const cur = sampleTrack(merged, time, "linear")!;
      const d = Math.hypot(
        cur.x + cur.w / 2 - (prev.x + prev.w / 2),
        cur.y + cur.h / 2 - (prev.y + prev.h / 2),
      );
      expect(d).toBeLessThan(5);
      prev = cur;
    }
  });

  it("UNconsumed pin (fresh drag, newer than the segment) still stamps — optimistic snap preserved", () => {
    const seg = manualSeg(7.6, 13.6, 1000);
    const t = trk({
      samples: seg.samples.map((s) => ({ ...s })),
      segments: [seg],
      manualAnchors: [displacedPin(10.6, 2000)],
    });
    const merged = mergeManualAnchorsIntoTrack(t);
    expect(merged).not.toBe(t);
    const at = sampleTrack(merged, 10.6, "linear")!;
    // The pin's center (305+105, 538+330) = (410, 868) is what renders.
    expect(Math.abs(at.x + at.w / 2 - 410)).toBeLessThan(2);
    expect(Math.abs(at.y + at.h / 2 - 868)).toBeLessThan(2);
  });

  it("pin with NO covering manual segment still stamps (engine-failed override)", () => {
    const t = trk({ manualAnchors: [displacedPin(10.6)] });
    const merged = mergeManualAnchorsIntoTrack(t);
    expect(merged).not.toBe(t);
    const at = sampleTrack(merged, 10.6, "linear")!;
    expect(Math.abs(at.y + at.h / 2 - 868)).toBeLessThan(2);
  });

  it("mergeAnchorOverridesIntoTrack applies the same consumption filter", () => {
    const seg = manualSeg(7.6, 13.6, 1000);
    const t = trk({
      samples: seg.samples.map((s) => ({ ...s })),
      segments: [seg],
      manualAnchors: [displacedPin(10.6)],
    });
    expect(mergeAnchorOverridesIntoTrack(t)).toBe(t);
  });
});
