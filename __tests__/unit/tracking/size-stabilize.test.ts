import { describe, it, expect } from "vitest";
import { stabilizeTrackSize, robustMedianWH } from "@/lib/tracking/size-stabilize";
import type { Track, TrackSample } from "@/lib/tracking/types";

function trk(samples: TrackSample[]): Track {
  return { id: "t", fileId: "f", label: "x", method: "m", framerate: 30,
    durationSec: samples.length ? samples[samples.length-1].t : 0,
    samples, segments: [], anchors: [] } as unknown as Track;
}
const steady = Array.from({length: 20}, (_, i) => ({ t: i/30, x:100, y:100, w:80, h:60, confidence:1, visible:true }));

describe("stabilizeTrackSize", () => {
  it("clamps a 5x-median spike to maxBoxScale and preserves center", () => {
    const s = steady.map(o => ({...o}));
    s[10] = { t:10/30, x:60, y:40, w:400, h:300, confidence:1, visible:true }; // center (260,190)
    const out = stabilizeTrackSize(trk(s), { mode: "stabilized", maxBoxScale: 1.75 });
    const f = out.samples[10];
    expect(f.w).toBeLessThanOrEqual(80 * 1.75 + 1e-6);
    expect(f.h).toBeLessThanOrEqual(60 * 1.75 + 1e-6);
    expect(f.x + f.w/2).toBeCloseTo(260, 4);
    expect(f.y + f.h/2).toBeCloseTo(190, 4);
  });
  it("mode raw returns the SAME ref (no-op)", () => {
    const t = trk(steady);
    expect(stabilizeTrackSize(t, { mode: "raw", maxBoxScale: 1.75 })).toBe(t);
  });
  it("no usable envelope (all invisible) returns same ref", () => {
    const t = trk(steady.map(o => ({...o, visible:false})));
    expect(stabilizeTrackSize(t, { mode: "stabilized", maxBoxScale: 1.75 })).toBe(t);
  });
  it("steady track within band is unchanged in values", () => {
    const out = stabilizeTrackSize(trk(steady), { mode: "stabilized", maxBoxScale: 1.75 });
    expect(out.samples.every((s, i) => s.w === steady[i].w && s.h === steady[i].h)).toBe(true);
  });
  it("robustMedianWH ignores invisible and degenerate (w<=0/h<=0)", () => {
    const med = robustMedianWH([
      { t:0,x:0,y:0,w:80,h:60,confidence:1,visible:true },
      { t:0,x:0,y:0,w:0,h:0,confidence:1,visible:true },
      { t:0,x:0,y:0,w:999,h:999,confidence:0,visible:false },
    ]);
    expect(med).toEqual({ w:80, h:60 });
  });
});

import {
  resizeAnchorFromOffset,
  resizeBox,
  CENTER_RESIZE_ANCHOR,
} from "@/lib/tracking/size-stabilize";

describe("resizeAnchorFromOffset", () => {
  it("no offset → center/center (legacy behavior)", () => {
    expect(resizeAnchorFromOffset(undefined)).toEqual(CENTER_RESIZE_ANCHOR);
    expect(resizeAnchorFromOffset(null)).toEqual(CENTER_RESIZE_ANCHOR);
    expect(resizeAnchorFromOffset({ x: 0, y: 0 })).toEqual({ x: "center", y: "center" });
  });
  it("overlay ABOVE the box (y:-0.5) → top edge is the reference", () => {
    expect(resizeAnchorFromOffset({ x: 0, y: -0.5 })).toEqual({ x: "center", y: "top" });
  });
  it("overlay BELOW (y:+0.5) → bottom; beside (x:±) → left/right", () => {
    expect(resizeAnchorFromOffset({ x: 0, y: 0.5 })).toEqual({ x: "center", y: "bottom" });
    expect(resizeAnchorFromOffset({ x: -0.4, y: 0 })).toEqual({ x: "left", y: "center" });
    expect(resizeAnchorFromOffset({ x: 0.4, y: 0 })).toEqual({ x: "right", y: "center" });
  });
  it("sub-threshold offsets (|v| < 0.25) stay center", () => {
    expect(resizeAnchorFromOffset({ x: 0.2, y: -0.2 })).toEqual({ x: "center", y: "center" });
  });
});

describe("resizeBox", () => {
  const s = { t: 0, x: 10, y: 20, w: 100, h: 50, confidence: 1, visible: true };
  it("center anchor preserves the box center (legacy semantics)", () => {
    const r = resizeBox(s, 80, 40, CENTER_RESIZE_ANCHOR);
    expect(r.x + r.w / 2).toBeCloseTo(60, 6);
    expect(r.y + r.h / 2).toBeCloseTo(45, 6);
  });
  it("top anchor holds y; bottom anchor holds y+h; right anchor holds x+w", () => {
    expect(resizeBox(s, 80, 40, { x: "center", y: "top" }).y).toBe(20);
    const b = resizeBox(s, 80, 40, { x: "center", y: "bottom" });
    expect(b.y + b.h).toBeCloseTo(70, 6);
    const r = resizeBox(s, 80, 40, { x: "right", y: "center" });
    expect(r.x + r.w).toBeCloseTo(110, 6);
  });
  it("unchanged dims return the SAME sample ref (memoization-critical)", () => {
    expect(resizeBox(s, 100, 50, { x: "center", y: "top" })).toBe(s);
  });
});

import { medianRuns } from "@/lib/tracking/size-stabilize";

// Detector flap fixture: head(90) ↔ head+neck(184) every 4th frame; TOP edge
// steady at y=100 (the real head-top barely moves) — so the raw CENTER
// bounces by ~(184-90)/2 = 47px on flap frames. 41 samples @30fps.
const flap = Array.from({ length: 41 }, (_, i) => ({
  t: i / 30, x: 200, y: 100, w: 80,
  h: i % 4 === 3 ? 184 : 90,
  confidence: 1, visible: true,
}));

describe("stabilizeTrackSize — temporal median stage", () => {
  it("top anchor: median kills the height flap AND the top edge never moves", () => {
    const out = stabilizeTrackSize(trk(flap), {
      mode: "stabilized", maxBoxScale: 1.75,
      resizeAnchor: { x: "center", y: "top" },
    });
    for (const s of out.samples) {
      expect(s.y).toBe(100);   // stable edge held → center = 100 + median(h)/2, constant
      expect(s.h).toBe(90);    // flap minority in every centered window → median 90
    }
  });

  it("center anchor (default): size smoothed but the center bounce REMAINS (finding 3)", () => {
    const out = stabilizeTrackSize(trk(flap), { mode: "stabilized", maxBoxScale: 1.75 });
    expect(out.samples.every((s) => s.h === 90)).toBe(true);
    // A flap frame's center was preserved through clamp (184→157.5, cy 192)
    // and median (→90, cy still 192) — the bounce is NOT fixed by lever 1 alone.
    const tall = out.samples[3];
    expect(tall.y + tall.h / 2).toBeCloseTo(192, 6);
    expect(out.samples.some((s) => s.y !== 100)).toBe(true);
  });

  it("temporalWindow: 1 reproduces the clamp-only (pre-change) behavior exactly", () => {
    const s = steady.map((o) => ({ ...o }));
    s[10] = { t: 10 / 30, x: 60, y: 40, w: 400, h: 300, confidence: 1, visible: true };
    const out = stabilizeTrackSize(trk(s), {
      mode: "stabilized", maxBoxScale: 1.75, temporalWindow: 1,
    });
    const f = out.samples[10];
    expect(f.w).toBeCloseTo(80 * 1.75, 6);           // clamped, NOT median'd away
    expect(f.h).toBeCloseTo(60 * 1.75, 6);
    expect(f.x + f.w / 2).toBeCloseTo(260, 4);        // center preserved (legacy)
    expect(f.y + f.h / 2).toBeCloseTo(190, 4);
  });

  it("a monotone size trend passes through untouched — SAME track ref (no lag, memoized)", () => {
    const grow = Array.from({ length: 30 }, (_, i) => ({
      t: i / 30, x: 0, y: 0, w: 80, h: 60 + i, confidence: 1, visible: true,
    }));
    const t = trk(grow);
    expect(stabilizeTrackSize(t, { mode: "stabilized", maxBoxScale: 1.75 })).toBe(t);
  });

  it("the median never blends across a time gap (two constant-size runs stay distinct)", () => {
    const runA = Array.from({ length: 8 }, (_, i) => ({
      t: i / 30, x: 0, y: 0, w: 80, h: 80, confidence: 1, visible: true,
    }));
    const runB = Array.from({ length: 8 }, (_, i) => ({
      t: 1 + i / 30, x: 0, y: 0, w: 80, h: 160, confidence: 1, visible: true,
    }));
    const out = stabilizeTrackSize(trk([...runA, ...runB]), {
      mode: "stabilized", maxBoxScale: 1.75,
    });
    expect(out.samples.slice(0, 8).every((s) => s.h === 80)).toBe(true);
    expect(out.samples.slice(8).every((s) => s.h === 160)).toBe(true);
  });

  it("an invisible sample splits runs and its degenerate dims never pollute the median", () => {
    const s = steady.map((o) => ({ ...o }));
    s[10] = { t: 10 / 30, x: 0, y: 0, w: 999, h: 999, confidence: 0, visible: false };
    const out = stabilizeTrackSize(trk(s), { mode: "stabilized", maxBoxScale: 1.75 });
    expect(out.samples[9].h).toBe(60);
    expect(out.samples[11].h).toBe(60);
    expect(out.samples[10]).toEqual(s[10]); // unusable sample untouched
  });

  it("a manual-pin sample is isolated: its exact dims pass through the median", () => {
    const s = steady.map((o) => ({ ...o }));
    s[10] = { t: 10 / 30, x: 90, y: 90, w: 100, h: 100, confidence: 1, visible: true };
    const t = trk(s);
    (t as Track).manualAnchors = [
      { id: "man-333", time: 10 / 30, bbox: [90, 90, 100, 100], createdAt: 1 },
    ];
    const out = stabilizeTrackSize(t, { mode: "stabilized", maxBoxScale: 1.75 });
    expect(out.samples[10].w).toBe(100); // NOT median'd to 80
    expect(out.samples[10].h).toBe(100);
    expect(out.samples[9].w).toBe(80);
  });

  it("medianRuns splits at segment startTime boundaries", () => {
    const s = steady.map((o) => ({ ...o }));
    const t = trk(s);
    (t as Track).segments = [
      { id: "a", startTime: 0, endTime: 10 / 30, method: "m", status: "ok", samples: [] },
      { id: "b", startTime: 10 / 30, endTime: 20 / 30, method: "m", status: "ok", samples: [] },
    ] as never;
    const runs = medianRuns(t, t.samples);
    expect(runs.length).toBe(2);
    expect(runs[0]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(runs[1][0]).toBe(10);
  });
});
