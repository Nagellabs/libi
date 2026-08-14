/**
 * Drop-frames readiness decision (pure).
 *
 * The transport's playback gate used to hold until the WORST source across the
 * whole active set had full runway — so 12 parallel videos spinner-buffered mid-
 * timeline while one lagging decoder caught up. Pro editors instead keep the MAIN
 * program output smooth and let secondary angles drop frames. This module encodes
 * that decision as a pure function of the active sources + their priorities:
 *
 *   - `allCanPaint` — NO active source would paint BLACK (each has a live-or-near
 *     frame OR a held last-good). The gate keeps this as a hard release
 *     precondition so we never release the clock into a black flash.
 *   - `dominantRunway` — the decoded runway of the DOMINANT (highest-priority)
 *     source. The gate releases on this (not the worst source), and the re-buffer
 *     detector trips on this ALONE — so a small/background PIP dropping frames can
 *     never re-buffer the whole composition.
 *
 * Splitting these two signals is the whole point: the GATE requires all-can-paint
 * (no black) AND dominant runway; the RE-BUFFER path keys off dominant runway only
 * (a black/stalled secondary is tolerated — it holds-last / drops frames).
 */

export interface ActiveSourceState {
  id: string;
  /** True when the source can paint SOMETHING at the playhead without a black
   *  flash — a live-or-near decoded frame OR a held last-good canvas. */
  canPaint: boolean;
  /** Strict LIVE decoded runway ahead of the playhead (seconds). By convention
   *  `-1` when the source can't serve a live frame at the playhead (same rule the
   *  old min-probe used), so a not-live DOMINANT holds the gate / trips re-buffer. */
  runway: number;
  /** Priority score (see `computeVideoPriorities`); higher = keep smoother. */
  priority: number;
}

export interface ReadyDecision {
  /** True when no active source would paint black (all can paint). */
  allCanPaint: boolean;
  /** The dominant (highest-priority) active source id, or null when none. */
  dominantId: string | null;
  /** The dominant source's LIVE runway (seconds). `Infinity` when the active set
   *  is empty — i.e. nothing gates (a pure canvas comp). */
  dominantRunway: number;
}

/**
 * Fold the active sources into a single gate/re-buffer decision. Pure +
 * deterministic (dominant ties broken by lowest id). An empty set means nothing
 * gates → `{ allCanPaint: true, dominantRunway: Infinity }`.
 */
export function computeReadyState(sources: ActiveSourceState[]): ReadyDecision {
  if (sources.length === 0) {
    return { allCanPaint: true, dominantId: null, dominantRunway: Infinity };
  }
  // Seed the dominant with the first source so a non-empty set ALWAYS resolves a
  // dominant — even if every priority is NaN (a `>` comparison against NaN is
  // always false, which would otherwise leave dominantRunway at a sentinel and
  // wedge the gate into a permanent false re-buffer). Ties / NaN keep the seed.
  let allCanPaint = sources[0].canPaint;
  let dominantId = sources[0].id;
  let dominantRunway = sources[0].runway;
  let bestPriority = sources[0].priority;
  for (let i = 1; i < sources.length; i++) {
    const s = sources[i];
    if (!s.canPaint) allCanPaint = false;
    const better =
      s.priority > bestPriority ||
      (s.priority === bestPriority && s.id < dominantId);
    if (better) {
      bestPriority = s.priority;
      dominantId = s.id;
      dominantRunway = s.runway;
    }
  }
  return { allCanPaint, dominantId, dominantRunway };
}
