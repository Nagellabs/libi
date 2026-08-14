/**
 * Proximity mount window (Phase 1A) — which video sources should have a LIVE
 * decoder mounted, given the playhead.
 *
 * Today `useVideoSources` mounts one decoder per video clip for the WHOLE session
 * (mount = composition membership), so a timeline of N cut/duplicate clips holds
 * N simultaneous WebCodecs decoders regardless of the playhead — the decoder-
 * session + memory wall (see the Phase-0 baseline note). This planner replaces
 * "mount everything" with "mount only what's near the playhead":
 *
 *  - **active**   — the playhead is inside the clip → MUST be mounted (the
 *                   renderer + the readiness gate read its frames).
 *  - **upcoming** — starts within `aheadSec` → mounted so it can WARM before the
 *                   cut reaches it (this is also the fix for the cold-start-after-
 *                   a-gap mid-play buffer: a wider ahead window warms the next
 *                   cluster earlier, so the gate doesn't hold when it activates).
 *  - **recent**   — ended within `behindSec` → kept mounted a little while so a
 *                   short scrub-back re-shows it WITHOUT a cold re-decode.
 *
 * Everything else is disposed. Pure + dependency-free so the mount decision is
 * unit-tested without a decoder; the hook applies the result idempotently and
 * uses a WIDER window for the dispose side (hysteresis) so a source parked right
 * at the boundary never flap-mounts. Never disposes an active source — that is the
 * load-bearing "decode-all-active" invariant (source-budget.ts): the proximity
 * window is a superset of active.
 */

export interface MountClip {
  id: string;
  /** Composition-timeline start (seconds). */
  startSec: number;
  /** Composition-timeline end (seconds). */
  endSec: number;
}

export interface MountWindowInput {
  playheadSec: number;
  clips: MountClip[];
  /** Mount an upcoming clip starting within this many seconds of the playhead.
   *  Must be ≥ WARM_AHEAD_SEC so a mounted-upcoming source has time to warm. */
  aheadSec: number;
  /** Keep a just-ended clip mounted this many seconds after it ends (scrub-back). */
  behindSec: number;
}

/**
 * The set of clip ids that should have a live decoder at `playheadSec`.
 * A clip qualifies if it is active, upcoming within `aheadSec`, or ended within
 * `behindSec`. Active is unconditional (never gated by the window sizes).
 */
export function planMountWindow(input: MountWindowInput): Set<string> {
  const { playheadSec: t, clips, aheadSec, behindSec } = input;
  const keep = new Set<string>();
  for (const c of clips) {
    const active = t >= c.startSec && t < c.endSec;
    const upcoming = c.startSec > t && c.startSec - t <= aheadSec;
    const recent = c.endSec <= t && t - c.endSec <= behindSec;
    if (active || upcoming || recent) keep.add(c.id);
  }
  return keep;
}
