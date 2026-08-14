import type { DuckSettings } from "@/lib/engine/types";

/** Sensible starting point for music-under-speech ducking. Matches
 *  Premiere's default Auto-Ducking preset within ~10%. */
export const DEFAULT_DUCK: DuckSettings = {
  sidechainClipId: "",
  thresholdDb: -30,
  ratio: 4,
  attackMs: 50,
  releaseMs: 250,
  reductionDb: -12,
};

/** Clamp every parameter to a safe musical range. Out-of-range inputs
 *  from agents or the API would otherwise crash either the WebAudio
 *  compressor (negative attack) or ffmpeg (ratio < 1). */
export function sanitizeDuck(d: DuckSettings): DuckSettings {
  return {
    sidechainClipId: d.sidechainClipId,
    thresholdDb: Math.min(0, Math.max(-60, d.thresholdDb)),
    ratio: Math.min(20, Math.max(1, d.ratio)),
    attackMs: Math.min(1000, Math.max(1, d.attackMs)),
    releaseMs: Math.min(5000, Math.max(1, d.releaseMs)),
    reductionDb: Math.min(0, Math.max(-60, d.reductionDb)),
  };
}

/** Lightweight clip shape used by `validateDuck` for cycle detection.
 *  Only needs `id` + `duck.sidechainClipId`. */
export interface DuckGraphNode {
  id: string;
  duck?: { sidechainClipId: string } | undefined;
}

/**
 * Validate a proposed duck setting.
 *
 * `existingClips` is the current `audioClips` array (any clip shape with
 * `id` + optional `duck` works). `proposedTargetId` is the clip the new
 * duck is being attached to — needed because the proposed edge isn't yet
 * in `existingClips`.
 *
 * Rejects:
 *   - empty sidechainClipId
 *   - sidechainClipId pointing at the target clip itself
 *   - sidechainClipId not present in existingClips
 *   - any cycle that would form once the proposed edge is added (DFS over
 *     the duck graph; ffmpeg's filter graph and Web Audio's MediaElement
 *     wiring both refuse cycles, and there's no musically-sensible
 *     interpretation of "A ducks B while B ducks A").
 */
export function validateDuck(
  d: DuckSettings,
  existingClips: DuckGraphNode[],
  proposedTargetId?: string,
): { ok: boolean; error?: string } {
  if (!d.sidechainClipId) return { ok: false, error: "sidechainClipId is required" };
  if (proposedTargetId && d.sidechainClipId === proposedTargetId) {
    return { ok: false, error: "A clip cannot duck itself" };
  }
  if (!existingClips.some((c) => c.id === d.sidechainClipId)) {
    return { ok: false, error: `Sidechain clip ${d.sidechainClipId} not found` };
  }

  // Cycle check: walk forward from sidechainClipId following duck edges;
  // if we ever reach proposedTargetId, the proposed edge would close a cycle.
  if (proposedTargetId) {
    const successors = new Map<string, string>();
    for (const c of existingClips) {
      if (c.duck?.sidechainClipId) successors.set(c.id, c.duck.sidechainClipId);
    }
    let cursor: string | undefined = d.sidechainClipId;
    const visited = new Set<string>();
    while (cursor) {
      if (cursor === proposedTargetId) {
        return { ok: false, error: `Ducking ${proposedTargetId} → ${d.sidechainClipId} would form a cycle` };
      }
      if (visited.has(cursor)) break; // pre-existing cycle elsewhere — not our problem
      visited.add(cursor);
      cursor = successors.get(cursor);
    }
  }

  return { ok: true };
}
