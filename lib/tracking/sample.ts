import type { Track, TrackSample, TrackSmoothing } from "@/lib/tracking/types";

function findBracket(samples: TrackSample[], t: number): [TrackSample, TrackSample] | null {
  if (samples.length === 0) return null;
  if (t < samples[0].t || t > samples[samples.length - 1].t) return null;
  let lo = 0, hi = samples.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return [samples[lo], samples[hi]];
}

function lerp(a: number, b: number, u: number) { return a + (b - a) * u; }

// Visibility is AND, not OR. A bracket containing one visible + one invisible
// end means we're sampling across a detection gap — we DON'T want to invent
// a position by lerping toward a stale `prev` value. Returning visible:false
// causes the renderer to hide the overlay during the gap.

function catmullRom(p0: number, p1: number, p2: number, p3: number, u: number) {
  const u2 = u * u, u3 = u2 * u;
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * u +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * u3
  );
}

export function sampleTrack(track: Track, t: number, mode: TrackSmoothing): TrackSample | null {
  const bracket = findBracket(track.samples, t);
  if (!bracket) return null;
  const [a, b] = bracket;
  if (a.t === b.t) return a;
  const u = (t - a.t) / (b.t - a.t);

  if (mode === "catmull-rom" && track.samples.length >= 4) {
    const ai = track.samples.indexOf(a);
    const p0 = track.samples[Math.max(0, ai - 1)];
    const p3 = track.samples[Math.min(track.samples.length - 1, ai + 2)];
    return {
      t,
      x: catmullRom(p0.x, a.x, b.x, p3.x, u),
      y: catmullRom(p0.y, a.y, b.y, p3.y, u),
      w: catmullRom(p0.w, a.w, b.w, p3.w, u),
      h: catmullRom(p0.h, a.h, b.h, p3.h, u),
      confidence: lerp(a.confidence, b.confidence, u),
      visible: a.visible && b.visible,
    };
  }

  // linear or kalman-fallback-to-linear for v1
  return {
    t,
    x: lerp(a.x, b.x, u),
    y: lerp(a.y, b.y, u),
    w: lerp(a.w, b.w, u),
    h: lerp(a.h, b.h, u),
    confidence: lerp(a.confidence, b.confidence, u),
    visible: a.visible && b.visible,
  };
}
