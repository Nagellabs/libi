// The ONE track-hydration seam: raw fetched/stored tracks → exactly what the
// renderer must see. Preview (hooks/preview/use-overlay-tracks.ts), export
// (lib/export/render-overlay-tracks.ts) and the verify-render route all apply
// the same THREE transforms in the same order:
//   1. mergeAnchorOverridesIntoTrack — stamp unconsumed manual pins + agent
//      re-anchors into the samples (manual > agent > engine),
//   2. stabilizeTrackSize — per-overlay box-size policy (default stabilized),
//   3. stabilizeTrackPosition — per-overlay box-CENTER One-Euro smoothing
//      (default stabilized; the tracked-overlay bounce fix — running here at
//      READ time fixes existing overlays with no re-track).
// Any new consumer of a Track that will be RENDERED must go through
// `prepareOverlayTracks` (or `prepareTrackForRender` for a single track with
// an explicit policy) — never sample a raw track directly.
//
// Deliberately hook-free and react-query-free: the export render page is a
// standalone esbuild browser bundle that must not drag in client-runtime deps.
import type { Overlay } from "@/lib/engine/types";
import type { Track } from "@/lib/tracking/types";
import { mergeAnchorOverridesIntoTrack } from "@/lib/tracking/manual-anchors";
import {
  stabilizeTrackSize,
  resizeAnchorFromOffset,
  type ResizeAnchor,
} from "@/lib/tracking/size-stabilize";
import { stabilizeTrackPosition } from "@/lib/tracking/position-stabilize";

export const DEFAULT_MAX_BOX_SCALE = 1.75;

/** The full per-overlay render policy (name kept from its size-only era to
 *  avoid churn — it now also carries the position policy). */
export interface TrackSizePolicy {
  sizeMode?: "stabilized" | "raw";
  maxBoxScale?: number;
  positionMode?: "stabilized" | "raw";
  /** Edge held fixed when size stabilization resizes a box. Derived from the
   *  overlay's follow offset (trackedSizePolicyByTrack / verify-render route);
   *  absent ⇒ center (legacy). INTERNAL — not an agent-facing field. */
  resizeAnchor?: ResizeAnchor;
  /** Temporal median window override (tuning/report harness only; <= 1 =
   *  clamp-only). Absent ⇒ SIZE_MEDIAN_WINDOW. INTERNAL. */
  sizeTemporalWindow?: number;
}

/** Per-track render policy derived from the tracked overlays. When several
 *  overlays share one trackId the LAST one wins — the rule the preview hook
 *  has always used (kept for exact preview parity). */
export function trackedSizePolicyByTrack(
  overlays: Overlay[],
): Record<string, TrackSizePolicy> {
  const policy: Record<string, TrackSizePolicy> = {};
  for (const o of overlays) {
    if (o.kind !== "tracked") continue;
    policy[o.trackId] = {
      sizeMode: o.sizeMode,
      maxBoxScale: o.maxBoxScale,
      positionMode: o.positionMode,
      resizeAnchor: resizeAnchorFromOffset(o.offset),
    };
  }
  return policy;
}

/** Pure: returns a new map with manual+agent anchors merged into every track
 *  so the renderer snaps to user corrections instantly. */
export function applyManualAnchorsToTrackMap(
  map: Record<string, Track>,
): Record<string, Track> {
  const out: Record<string, Track> = {};
  for (const [id, t] of Object.entries(map)) {
    out[id] = mergeAnchorOverridesIntoTrack(t);
  }
  return out;
}

/** Pure: per-track size-stabilization policy (from each tracked overlay).
 *  Defaults applied when the overlay omits the fields. */
export function applyOverlaySizeStabilization(
  map: Record<string, Track>,
  policyByTrack: Record<string, TrackSizePolicy>,
): Record<string, Track> {
  const out: Record<string, Track> = {};
  for (const [id, t] of Object.entries(map)) {
    const p = policyByTrack[id] ?? {};
    out[id] = stabilizeTrackSize(t, {
      mode: p.sizeMode ?? "stabilized",
      maxBoxScale: p.maxBoxScale ?? DEFAULT_MAX_BOX_SCALE,
      resizeAnchor: p.resizeAnchor,
      temporalWindow: p.sizeTemporalWindow,
    });
  }
  return out;
}

/** Pure: per-track position-stabilization policy (from each tracked overlay).
 *  Default "stabilized" when the overlay omits the field. */
export function applyOverlayPositionStabilization(
  map: Record<string, Track>,
  policyByTrack: Record<string, TrackSizePolicy>,
): Record<string, Track> {
  const out: Record<string, Track> = {};
  for (const [id, t] of Object.entries(map)) {
    const p = policyByTrack[id] ?? {};
    out[id] = stabilizeTrackPosition(t, {
      mode: p.positionMode ?? "stabilized",
    });
  }
  return out;
}

/** ONE track + ONE explicit policy → renderer-ready track. The single
 *  composition point shared by prepareOverlayTracks AND the verify-render
 *  route (which overrides the policy per request pre-attach). Order: anchor
 *  merge → size stabilize (center-preserving) → position stabilize
 *  (size-preserving). The two stabilizers commute, but position must run
 *  AFTER the merge so pin times exist in the samples to snap to. */
export function prepareTrackForRender(
  track: Track,
  policy: TrackSizePolicy = {},
): Track {
  const merged = mergeAnchorOverridesIntoTrack(track);
  const sized = stabilizeTrackSize(merged, {
    mode: policy.sizeMode ?? "stabilized",
    maxBoxScale: policy.maxBoxScale ?? DEFAULT_MAX_BOX_SCALE,
    resizeAnchor: policy.resizeAnchor,
    temporalWindow: policy.sizeTemporalWindow,
  });
  return stabilizeTrackPosition(sized, {
    mode: policy.positionMode ?? "stabilized",
  });
}

/** Raw track map + the composition's overlays → renderer-ready tracks. */
export function prepareOverlayTracks(
  map: Record<string, Track>,
  overlays: Overlay[],
): Record<string, Track> {
  const policy = trackedSizePolicyByTrack(overlays);
  const out: Record<string, Track> = {};
  for (const [id, t] of Object.entries(map)) {
    out[id] = prepareTrackForRender(t, policy[id] ?? {});
  }
  return out;
}
