export interface BudgetClip { id: string; startSec: number; endSec: number; }
export type SourceState = "active" | "warm" | "cold";

export interface BudgetInput {
  playheadSec: number;
  clips: BudgetClip[];
  /** Max concurrent live (active+warm) decoders. */
  k: number;
  /** Seconds ahead of a clip's start at which it begins warming. */
  warmAheadSec: number;
}

/**
 * Decide active/warm/cold per clip.
 *
 * **Active = covers the playhead, and is NEVER capped.** Every video overlapping
 * the playhead gets a live decoder so an N-up layout (e.g. 5 videos side by side)
 * actually renders all N. If the machine genuinely can't sustain that decode load,
 * the transport's decode-backpressure gate holds the clock + shows a spinner
 * (graceful), rather than the planner force-pausing some active sources (which
 * could only ever show stale frames).
 *
 * **Warm = starts within `warmAheadSec` ahead** — pre-decoded so its first frame
 * is ready at the cut. Warm IS budgeted: only the nearest `k - activeCount` warm
 * candidates are kept (≥0), the rest cold. This caps *speculative* off-screen
 * decoding without ever starving an on-screen source.
 *
 * Everything else is cold (hold-last-frame at draw time).
 */
export function planSourceBudget(input: BudgetInput): Map<string, SourceState> {
  const { playheadSec: t, clips, k, warmAheadSec } = input;
  const plan = new Map<string, SourceState>();
  for (const c of clips) plan.set(c.id, "cold");

  const active: string[] = [];
  const warmCandidates: { id: string; distance: number }[] = [];
  for (const c of clips) {
    if (t >= c.startSec && t < c.endSec) active.push(c.id);
    else if (c.startSec > t && c.startSec - t <= warmAheadSec)
      warmCandidates.push({ id: c.id, distance: c.startSec - t });
  }

  // Active is unconditional — never capped by K.
  for (const id of active) plan.set(id, "active");

  // Warm fills only the remaining live slots (k minus the active count), nearest
  // first. Clamp at 0 so an active count ≥ K leaves no warm slots (never negative).
  warmCandidates.sort((a, b) => a.distance - b.distance);
  const warmSlots = Math.max(0, k - active.length);
  for (let i = 0; i < warmCandidates.length && i < warmSlots; i++) {
    plan.set(warmCandidates[i].id, "warm");
  }
  return plan;
}
