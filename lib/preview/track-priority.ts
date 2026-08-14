/**
 * Track priority (drop-frames playback model).
 *
 * Not every active video is equally important to keep smooth. A full-frame video
 * you're watching matters far more than a tiny background PIP. Pro editors (Resolve
 * multicam, Premiere) keep the MAIN output smooth and let secondary angles drop
 * frames under load rather than spinner-buffering the whole timeline. This module
 * scores each active video so the readiness gate + re-buffer key off the DOMINANT
 * (highest-priority) source, while lower-priority ones degrade first.
 *
 * Score = weighted( on-screen AREA, z-ORDER front-ness, on-screen DURATION ) ×
 * OPACITY. Bigger + more in front + longer + more opaque ⇒ higher priority — the
 * intuitive "how much is this video actually showing" heuristic.
 */

export interface PriorityTrack {
  id: string;
  /** Rect area as a fraction of the composition (0..1). Full-frame base scene = 1. */
  areaFraction: number;
  /** Render order — higher z is more in FRONT (occludes lower). */
  z: number;
  /** Overlay opacity (0..1); 1 for base scenes. */
  opacity: number;
  /** Clip duration in seconds — a proxy for "on screen for more time". */
  durationSec: number;
}

// Weights: AREA dominates (visual importance), z-order + duration are secondary
// tie-breakers. Sum of the three = 1.0 before the opacity multiply.
const W_AREA = 0.6;
const W_Z = 0.25;
const W_DURATION = 0.15;

/**
 * Score every active video 0..1 (higher = keep smoother). Ranks are computed
 * RELATIVE to the current active set (z + duration normalized across it), so the
 * scores are meaningful for picking the dominant even when all clips are similar.
 * Pure + deterministic.
 */
export function computeVideoPriorities(tracks: PriorityTrack[]): Map<string, number> {
  const out = new Map<string, number>();
  if (tracks.length === 0) return out;

  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxDur = 0;
  for (const t of tracks) {
    if (t.z < minZ) minZ = t.z;
    if (t.z > maxZ) maxZ = t.z;
    if (t.durationSec > maxDur) maxDur = t.durationSec;
  }
  const zSpan = maxZ - minZ;

  // Clamp to 0..1, treating a non-finite input (undefined/NaN from loosely-typed
  // persisted data) as the neutral default so a score can NEVER be NaN — a NaN
  // score silently loses every `>` comparison in pickDominant/computeReadyState
  // and would leave the gate with no dominant (a false permanent re-buffer).
  const clamp01 = (v: number, dflt: number) =>
    Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : dflt;
  for (const t of tracks) {
    // Front-ness 0..1 (highest z = 1). Single-clip / all-equal-z sets → 1.
    const zRank = zSpan > 0 ? (t.z - minZ) / zSpan : 1;
    // On-screen-time 0..1 relative to the longest active clip.
    const durRank = maxDur > 0 ? Math.min(1, t.durationSec / maxDur) : 1;
    const area = clamp01(t.areaFraction, 0);
    const opacity = clamp01(t.opacity, 1); // absent opacity ⇒ fully opaque
    const score = (W_AREA * area + W_Z * zRank + W_DURATION * durRank) * opacity;
    out.set(t.id, score);
  }
  return out;
}

/**
 * The dominant (highest-priority) track id, or null when there are none. Ties
 * broken deterministically by id so the choice is stable frame-to-frame.
 */
export function pickDominant(scores: Map<string, number>): string | null {
  let bestId: string | null = null;
  let bestScore = -Infinity;
  for (const [id, s] of scores) {
    if (s > bestScore || (s === bestScore && (bestId === null || id < bestId))) {
      bestScore = s;
      bestId = id;
    }
  }
  return bestId;
}
