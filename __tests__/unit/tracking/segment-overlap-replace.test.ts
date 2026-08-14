import { describe, it, expect } from "vitest";
import {
  deriveSamples,
  normalizeTrack,
  resolveSegmentOverlaps,
  type TrackSegment,
} from "@/lib/tracking/segments";
import type { Track, TrackSample } from "@/lib/tracking/types";

/** Invisible engine miss samples (the honest zeroed shape pipeline.py emits). */
function lostSamples(start: number, end: number, step = 0.5): TrackSample[] {
  const out: TrackSample[] = [];
  for (let t = start; t <= end + 1e-9; t += step) {
    out.push({ t: Math.round(t * 1000) / 1000, x: 0, y: 0, w: 0, h: 0, confidence: 0, visible: false });
  }
  return out;
}

function okSamples(start: number, end: number, step = 0.5, x = 50): TrackSample[] {
  const out: TrackSample[] = [];
  for (let t = start; t <= end + 1e-9; t += step) {
    out.push({ t: Math.round(t * 1000) / 1000, x, y: 40, w: 30, h: 60, confidence: 0.9, visible: true });
  }
  return out;
}

const base: Omit<Track, "segments"> = {
  id: "trk",
  fileId: "f",
  method: "yoloe+botsort",
  framerate: 15,
  durationSec: 19.021,
  samples: [],
};

describe("task-39 Bug 2 — sot recompute over a slightly-different range must supersede the failed engine segment", () => {
  // The incident shape: the yoloe+botsort fan-out wrote a LOST segment
  // [0, 18.933] (284 samples, 0 visible) and the sot repair then wrote an
  // OVERLAPPING ok segment [0, 19.021]. On a legacy (no-provenance) sidecar,
  // inferSegmentProvenance labeled the WIDER sot repair "engine" (full range)
  // and the stale lost segment "agent" (narrower), inverting the stitch so
  // deriveSamples resurrected the all-invisible engine samples over the
  // repair — the track rendered nothing and only delete-and-rebuild helped.
  it("legacy (no provenance) sidecar: the lost engine segment must NOT resurrect over the sot repair", () => {
    const engineLost: TrackSegment = {
      id: "seg-0-18933",
      startTime: 0,
      endTime: 18.933,
      method: "yoloe+botsort",
      status: "lost",
      samples: lostSamples(0, 18.9),
    };
    const sotRepair: TrackSegment = {
      id: "seg-0-19021",
      startTime: 0,
      endTime: 19.021,
      method: "sot",
      status: "ok",
      samples: okSamples(0, 19.0),
    };
    const normalized = normalizeTrack({ ...base, segments: [engineLost, sotRepair] });
    const visible = (normalized.samples ?? []).filter((s) => s.visible);
    // Every sot sample must survive; the invisible engine samples must not win.
    expect(visible.length).toBe(sotRepair.samples.length);
    expect((normalized.samples ?? []).every((s) => s.visible)).toBe(true);
  });

  it("explicit provenance, equal rank + equal createdAt: an ok segment beats an overlapping lost one regardless of span", () => {
    const engineLost: TrackSegment = {
      id: "seg-0-18933",
      startTime: 0,
      endTime: 18.933,
      method: "yoloe+botsort",
      status: "lost",
      provenance: "engine",
      samples: lostSamples(0, 18.9),
    };
    const engineOk: TrackSegment = {
      id: "seg-0-19021",
      startTime: 0,
      endTime: 19.021,
      method: "sot",
      status: "ok",
      provenance: "engine",
      samples: okSamples(0, 19.0),
    };
    // Narrower-wins would resurrect the lost segment here (18.933 < 19.021).
    const out = deriveSamples({ ...base, segments: [engineLost, engineOk] });
    expect(out.every((s) => s.visible)).toBe(true);
  });
});

describe("resolveSegmentOverlaps — write-time replacement (upsertSegment)", () => {
  const mkSeg = (over: Partial<TrackSegment>): TrackSegment => ({
    id: "seg-x",
    startTime: 0,
    endTime: 10,
    method: "yoloe+botsort",
    status: "ok",
    samples: [],
    ...over,
  });

  it("drops a fully-covered sibling of equal-or-lower precedence (the incident: [0,18.933] superseded by [0,19.021])", () => {
    const stale = mkSeg({ id: "seg-0-18933", startTime: 0, endTime: 18.933, status: "lost", provenance: "engine" });
    const incoming = mkSeg({ id: "seg-0-19021", startTime: 0, endTime: 19.021, method: "sot", provenance: "agent", createdAt: 2 });
    expect(resolveSegmentOverlaps([stale], incoming)).toEqual([]);
  });

  it("trims a partially-overlapping sibling at the edges (samples in the disputed window removed)", () => {
    const left = mkSeg({
      id: "seg-0-8", startTime: 0, endTime: 8, provenance: "engine",
      samples: okSamples(0, 8, 1),
    });
    const right = mkSeg({
      id: "seg-12-20", startTime: 12, endTime: 20, provenance: "engine",
      samples: okSamples(12, 20, 1),
    });
    const incoming = mkSeg({ id: "seg-5-15", startTime: 5, endTime: 15, provenance: "agent", createdAt: 2 });
    const out = resolveSegmentOverlaps([left, right], incoming);
    expect(out).toHaveLength(2);
    const l = out.find((s) => s.id === "seg-0-8")!;
    const r = out.find((s) => s.id === "seg-12-20")!;
    expect(l.endTime).toBe(5);
    expect(l.samples.every((p) => p.t < 5)).toBe(true);
    expect(r.startTime).toBe(15);
    expect(r.samples.every((p) => p.t > 15)).toBe(true);
  });

  it("leaves a HIGHER-precedence sibling untouched (an engine re-run cannot wipe a manual repair)", () => {
    const manual = mkSeg({ id: "seg-manual", startTime: 2, endTime: 6, provenance: "manual", createdAt: 1 });
    const incoming = mkSeg({ id: "seg-0-10", startTime: 0, endTime: 10, provenance: "engine", createdAt: 2 });
    expect(resolveSegmentOverlaps([manual], incoming)).toEqual([manual]);
  });

  it("leaves a CONTAINING sibling untouched (narrow carve-out keeps the wide seed — composable semantics)", () => {
    const wide = mkSeg({ id: "seg-0-10", startTime: 0, endTime: 10, provenance: "engine", samples: okSamples(0, 10, 1) });
    const incoming = mkSeg({ id: "seg-4-6", startTime: 4, endTime: 6, provenance: "agent", createdAt: 2 });
    expect(resolveSegmentOverlaps([wide], incoming)).toEqual([wide]);
  });

  it("touching boundaries are not overlap (contiguous shot fan-out preserved)", () => {
    const next = mkSeg({ id: "seg-10-20", startTime: 10, endTime: 20, provenance: "engine" });
    const incoming = mkSeg({ id: "seg-0-10", startTime: 0, endTime: 10, provenance: "engine", createdAt: 2 });
    expect(resolveSegmentOverlaps([next], incoming)).toEqual([next]);
  });
});
