import { describe, it, expect } from "vitest";
import {
  stabilizeTrackPosition,
  POSITION_RESET_GAP_SEC,
} from "@/lib/tracking/position-stabilize";
import type { Track, TrackSample } from "@/lib/tracking/types";

const FPS = 30;

function sample(i: number, cy: number, over: Partial<TrackSample> = {}): TrackSample {
  return {
    t: i / FPS,
    x: 200 - 40,
    y: cy - 30,
    w: 80,
    h: 60,
    confidence: 1,
    visible: true,
    ...over,
  };
}

function mk(samples: TrackSample[], extra: Partial<Track> = {}): Track {
  return {
    id: "trk-1",
    fileId: "f",
    label: "s",
    method: "yoloe+botsort",
    framerate: FPS,
    durationSec: samples.length / FPS,
    samples,
    segments: [
      {
        id: "seg-all",
        startTime: 0,
        endTime: samples.length / FPS,
        method: "yoloe+botsort",
        status: "ok",
        samples,
      },
    ],
    ...extra,
  } as unknown as Track;
}

function meanAbsDeltaCy(ss: TrackSample[]): number {
  const vis = ss.filter((s) => s.visible);
  let sum = 0;
  for (let i = 1; i < vis.length; i++) {
    sum += Math.abs(vis[i].y + vis[i].h / 2 - (vis[i - 1].y + vis[i - 1].h / 2));
  }
  return sum / (vis.length - 1);
}

describe("stabilizeTrackPosition", () => {
  it("drops frame-to-frame center-Y jitter by >70% and never touches w/h/visible/t", () => {
    const jittery = Array.from({ length: 120 }, (_, i) =>
      sample(i, 300 + (i % 2 === 0 ? 6 : -6)),
    );
    const track = mk(jittery);
    const out = stabilizeTrackPosition(track, { mode: "stabilized" });
    expect(meanAbsDeltaCy(out.samples)).toBeLessThan(0.3 * meanAbsDeltaCy(track.samples));
    for (let i = 0; i < out.samples.length; i++) {
      expect(out.samples[i].w).toBe(track.samples[i].w);
      expect(out.samples[i].h).toBe(track.samples[i].h);
      expect(out.samples[i].visible).toBe(track.samples[i].visible);
      expect(out.samples[i].t).toBe(track.samples[i].t);
    }
  });

  it('mode:"raw" is a same-ref no-op', () => {
    const track = mk(
      Array.from({ length: 10 }, (_, i) => sample(i, 300 + (i % 2) * 6)),
    );
    expect(stabilizeTrackPosition(track, { mode: "raw" })).toBe(track);
  });

  it("returns the same ref when nothing changes (constant track — memoization-safe)", () => {
    const track = mk(Array.from({ length: 30 }, (_, i) => sample(i, 300)));
    expect(stabilizeTrackPosition(track, { mode: "stabilized" })).toBe(track);
  });

  it("snaps EXACTLY at a manual pin (never smooths through ground truth)", () => {
    // Constant center at cy=300 with a pin-stamped outlier at t=1.0, cy=400.
    const samples = Array.from({ length: 60 }, (_, i) =>
      i === 30 ? sample(i, 400) : sample(i, 300),
    );
    const track = mk(samples, {
      manualAnchors: [
        { id: "man-1000", time: 1.0, bbox: [160, 370, 80, 60], createdAt: 1 },
      ],
    });
    const out = stabilizeTrackPosition(track, { mode: "stabilized" });
    const at = out.samples[30];
    expect(at.y + at.h / 2).toBe(400); // exact — the pin is ground truth
    expect(at.x).toBe(track.samples[30].x);
  });

  it("resets across a visibility gap (hidden→visible jump is never smoothed)", () => {
    const samples = [
      ...Array.from({ length: 15 }, (_, i) => sample(i, 300)),
      ...Array.from({ length: 10 }, (_, i) =>
        sample(15 + i, 300, { visible: false, confidence: 0 }),
      ),
      ...Array.from({ length: 15 }, (_, i) => sample(25 + i, 700)), // reappears far away
    ];
    const out = stabilizeTrackPosition(mk(samples), { mode: "stabilized" });
    const first = out.samples[25];
    expect(first.y + first.h / 2).toBe(700); // passthrough, no ease from 300
    // Invisible samples are untouched by identity.
    expect(out.samples[20]).toBe(samples[20]);
  });

  it("resets at a segment boundary (a method hand-off is a new context)", () => {
    const a = Array.from({ length: 15 }, (_, i) => sample(i, 300));
    const b = Array.from({ length: 15 }, (_, i) => sample(15 + i, 500));
    const track = mk([...a, ...b], {
      segments: [
        { id: "seg-a", startTime: 0, endTime: 14 / FPS, method: "yoloe+botsort", status: "ok", samples: a },
        { id: "seg-b", startTime: 15 / FPS, endTime: 29 / FPS, method: "sot", status: "ok", samples: b },
      ],
    });
    const out = stabilizeTrackPosition(track, { mode: "stabilized" });
    const first = out.samples[15];
    expect(first.y + first.h / 2).toBe(500); // snapped at the join, not eased
  });

  it("resets after a long sample gap even without invisible markers", () => {
    const a = Array.from({ length: 10 }, (_, i) => sample(i, 300));
    const late = [sample(60, 700)]; // 1.7s hole in the stitch
    const out = stabilizeTrackPosition(mk([...a, ...late]), { mode: "stabilized" });
    const s = out.samples[10];
    expect(s.y + s.h / 2).toBe(700);
    expect(POSITION_RESET_GAP_SEC).toBeLessThan(1.7);
  });

  it("leaves segments[].samples RAW (provenance/quality data is not a render view)", () => {
    const jittery = Array.from({ length: 60 }, (_, i) =>
      sample(i, 300 + (i % 2 === 0 ? 6 : -6)),
    );
    const track = mk(jittery);
    const out = stabilizeTrackPosition(track, { mode: "stabilized" });
    expect(out.segments).toBe(track.segments);
  });
});
