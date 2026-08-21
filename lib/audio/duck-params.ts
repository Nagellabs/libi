import type { DuckSettings } from "@/lib/engine/types";

/** Sensible starting point for music-under-speech ducking. Matches
 *  Premiere's default Auto-Ducking preset within ~10%. */
export const DEFAULT_DUCK: DuckSettings = {
  sidechainClipIds: [],
  thresholdDb: -30,
  ratio: 4,
  attackMs: 50,
  releaseMs: 250,
  reductionDb: -12,
};

/**
 * The linear gain FLOOR a duck may pull its target down to — the one place
 * `reductionDb` is turned into a number, shared by both engines so they cannot
 * drift apart.
 *
 * `reductionDb` is a REDUCTION: -12 means "at most 12 dB down", i.e. a floor of
 * 10^(-12/20) = 0.251. It is never a boost, so the result is always in (0, 1].
 *
 * The preview feeds this straight to the worklet's `reductionMin`
 * (`applyDuckParams`); the export derives ffmpeg's `mix` from it
 * (`buildAudioMixGraph`). Before 2026-08-18 the export instead passed
 * `-reductionDb` as ffmpeg's `makeup`, which is a LINEAR multiplier (range
 * 1–64, default 1) — so a -12 dB duck became a 12x, +21.6 dB BOOST on the
 * music and hard-clipped 10% of every exported mix. Route new consumers
 * through here rather than recomputing the conversion.
 */
export function duckReductionFloor(reductionDb: number): number {
  return Math.pow(10, Math.min(0, reductionDb) / 20);
}

/** Either spelling of the sidechain list, as it arrives from a manifest, an
 *  MCP call, or the HTTP route. `sanitizeDuck` turns it into `DuckSettings`. */
export interface DuckSettingsInput extends Omit<DuckSettings, "sidechainClipIds"> {
  sidechainClipIds?: readonly string[];
  /** @deprecated Pre-2026-08-18 single-sidechain spelling. Read, never written. */
  sidechainClipId?: string;
}

/** Anything carrying a sidechain reference in either spelling. */
export type DuckSidechainRef = {
  sidechainClipIds?: readonly string[];
  /** @deprecated */
  sidechainClipId?: string;
};

/**
 * THE sidechain-list reader: the array when present, otherwise the legacy
 * single id wrapped in one. Empty and duplicate ids are dropped, order kept.
 *
 * A duck used to have exactly one sidechain, which forced a real piece with six
 * voice-over lines to be bounced into a single 42-second "VO bus" clip and
 * re-rendered on every retime. Manifests written before that changed still say
 * `sidechainClipId`; normalizing here — and in `sanitizeDuck`, which is what
 * `loadManifest` runs over every clip — is why no migration script is needed.
 */
export function duckSidechainIds(d: DuckSidechainRef): string[] {
  const raw = d.sidechainClipIds ?? (d.sidechainClipId ? [d.sidechainClipId] : []);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of raw) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Clamp every parameter to a safe musical range, and normalize the sidechain
 *  list to `sidechainClipIds`. Out-of-range inputs from agents or the API would
 *  otherwise crash either the WebAudio compressor (negative attack) or ffmpeg
 *  (ratio < 1). The legacy `sidechainClipId` key is never carried through. */
export function sanitizeDuck(d: DuckSettingsInput): DuckSettings {
  return {
    sidechainClipIds: duckSidechainIds(d),
    thresholdDb: Math.min(0, Math.max(-60, d.thresholdDb)),
    ratio: Math.min(20, Math.max(1, d.ratio)),
    attackMs: Math.min(1000, Math.max(1, d.attackMs)),
    releaseMs: Math.min(5000, Math.max(1, d.releaseMs)),
    reductionDb: Math.min(0, Math.max(-60, d.reductionDb)),
  };
}

/** Lightweight clip shape used by `validateDuck` for cycle detection.
 *  Only needs `id` + the duck's sidechain refs (either spelling). */
export interface DuckGraphNode {
  id: string;
  duck?: DuckSidechainRef | undefined;
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
 *   - an empty sidechain list
 *   - any sidechain pointing at the target clip itself
 *   - any sidechain not present in existingClips
 *   - any cycle that would form once the proposed edges are added (DFS over
 *     the duck graph; ffmpeg's filter graph and Web Audio's MediaElement
 *     wiring both refuse cycles, and there's no musically-sensible
 *     interpretation of "A ducks B while B ducks A").
 *
 * A duck now has N sidechains, so the graph branches: every clip has a LIST of
 * out-edges and the walk has to follow all of them. Chasing only the first
 * would let a cycle through the second sidechain slip past.
 */
export function validateDuck(
  d: DuckSettingsInput | DuckSettings,
  existingClips: DuckGraphNode[],
  proposedTargetId?: string,
): { ok: boolean; error?: string } {
  const ids = duckSidechainIds(d);
  if (ids.length === 0) return { ok: false, error: "sidechainClipIds is required" };
  for (const id of ids) {
    if (proposedTargetId && id === proposedTargetId) {
      return { ok: false, error: "A clip cannot duck itself" };
    }
    if (!existingClips.some((c) => c.id === id)) {
      return { ok: false, error: `Sidechain clip ${id} not found` };
    }
  }

  // Cycle check: walk forward from every proposed sidechain following duck
  // edges; if we ever reach proposedTargetId, the proposed edge closes a cycle.
  if (proposedTargetId) {
    const successors = new Map<string, string[]>();
    for (const c of existingClips) {
      if (c.duck) successors.set(c.id, duckSidechainIds(c.duck));
    }
    const stack = [...ids];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const cursor = stack.pop()!;
      if (cursor === proposedTargetId) {
        return {
          ok: false,
          error: `Ducking ${proposedTargetId} → ${ids.join(", ")} would form a cycle`,
        };
      }
      if (visited.has(cursor)) continue; // pre-existing cycle elsewhere — not our problem
      visited.add(cursor);
      stack.push(...(successors.get(cursor) ?? []));
    }
  }

  return { ok: true };
}
