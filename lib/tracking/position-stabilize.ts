import type { Track, TrackSample } from "@/lib/tracking/types";
import {
  DEFAULT_ONE_EURO_PARAMS,
  OneEuroFilter,
  type OneEuroParams,
} from "@/lib/tracking/one-euro";

export interface PositionStabilizeOpts {
  mode: "stabilized" | "raw";
  /** One-Euro tuning. Defaults to DEFAULT_ONE_EURO_PARAMS. */
  params?: OneEuroParams;
}

/** A time gap between consecutive usable samples longer than this resets the
 *  filter even without an explicit visible:false sample in between (dropped
 *  frames / sparse stitches must never be smoothed across). */
export const POSITION_RESET_GAP_SEC = 0.25;

function pinEps(track: Track): number {
  return track.framerate > 0 ? 0.5 / track.framerate : 1e-4;
}

/** Segment-join times: crossing one resets the filter — a new segment is a
 *  new detection context (often a different method/provenance); a hand-off
 *  must snap, not ease. */
function segmentBoundaries(track: Track): number[] {
  const ts = new Set<number>();
  for (const seg of track.segments ?? []) ts.add(seg.startTime);
  return [...ts].sort((a, b) => a - b);
}

/**
 * Render-time position policy: One-Euro-filter the box CENTER of every
 * visible sample (w/h/visible/confidence untouched — size policy is
 * stabilizeTrackSize's job). Runs at READ time in the hydration seam, so
 * existing overlays are fixed with no re-track.
 *
 * Reset points (filter state dropped → next sample passes through exactly):
 *  - any visible:false / degenerate sample (never smooth a hidden→visible jump),
 *  - a segment startTime crossed between consecutive usable samples,
 *  - a gap > POSITION_RESET_GAP_SEC,
 *  - a manual-pin time (track.manualAnchors) — the pin is ground truth: the
 *    filtered position SNAPS to it and seeds subsequent smoothing from it.
 *
 * `mode:"raw"` and no-change runs return the SAME track ref (memoization).
 * `segments[].samples` stay RAW deliberately: they are provenance/quality
 * data (summary flags and per-segment tables must judge the TRACKER, not the
 * render filter), and a stateful filter is only meaningful over the stitched
 * render sequence in `samples`.
 */
export function stabilizeTrackPosition(
  track: Track,
  opts: PositionStabilizeOpts,
): Track {
  if (opts.mode === "raw") return track;
  const usable = track.samples.filter((s) => s.visible && s.w > 0 && s.h > 0);
  if (usable.length < 2) return track;

  const params = opts.params ?? DEFAULT_ONE_EURO_PARAMS;
  const fx = new OneEuroFilter(params);
  const fy = new OneEuroFilter(params);
  const eps = pinEps(track);
  const pins = (track.manualAnchors ?? []).map((a) => a.time);
  const boundaries = segmentBoundaries(track);

  let prevUsableT: number | null = null;
  let changed = false;
  const samples = track.samples.map((s): TrackSample => {
    if (!s.visible || s.w <= 0 || s.h <= 0) {
      // Continuity broken: the next visible sample must snap, not ease.
      fx.reset();
      fy.reset();
      prevUsableT = null;
      return s;
    }
    const pt = prevUsableT;
    const crossedBoundary =
      pt !== null && boundaries.some((b) => pt < b && b <= s.t);
    const gap = pt !== null && s.t - pt > POSITION_RESET_GAP_SEC;
    const isPin = pins.some((p) => Math.abs(s.t - p) <= eps);
    if (crossedBoundary || gap || isPin) {
      fx.reset();
      fy.reset();
    }
    prevUsableT = s.t;
    const cx = s.x + s.w / 2;
    const cy = s.y + s.h / 2;
    const ncx = fx.filter(cx, s.t);
    const ncy = fy.filter(cy, s.t);
    if (ncx === cx && ncy === cy) return s;
    changed = true;
    return { ...s, x: ncx - s.w / 2, y: ncy - s.h / 2 };
  });

  if (!changed) return track;
  return { ...track, samples };
}
