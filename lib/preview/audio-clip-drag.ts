/**
 * Pure position/drag math for an audio clip bar on the timeline — the SINGLE
 * source of truth shared by the coupled strip and the detached / free audio
 * rows. NO React, NO DOM; unit-tested in isolation.
 *
 * Two concerns live here:
 *  1. pointer-px → committed [startTime,duration] (horizontal drag), and
 *  2. the OPTIMISTIC-HOLD reconcile rule that decides which start/duration a bar
 *     should DISPLAY while a just-committed value is still propagating through
 *     React Query (server PATCH → SSE refetch). Without this, a bar repaints one
 *     frame at its stale persisted position on release — the "jump-back-then-
 *     forward" flash. The video/coupled bars never flashed because they commit
 *     through the overlay-edit store, which holds the value until the server
 *     composition provably reflects it; this brings the same guarantee to audio.
 */

/** A clip's timeline window in seconds. */
export interface ClipTiming {
  startTime: number;
  duration: number;
}

/**
 * Convert a horizontal pointer delta (px) into a new clip start, clamped so the
 * start never goes negative. Returns the FULL committed timing (duration
 * unchanged — audio bars move, they don't trim here).
 */
export function dragToTiming(
  base: ClipTiming,
  deltaPx: number,
  pxPerSec: number,
): ClipTiming {
  const rawDeltaSec = pxPerSec > 0 ? deltaPx / pxPerSec : 0;
  const deltaSec = Math.max(-base.startTime, rawDeltaSec);
  return { startTime: base.startTime + deltaSec, duration: base.duration };
}

/** True when two timings are equal within a sub-frame epsilon (1ms). */
export function timingReflects(a: ClipTiming, b: ClipTiming): boolean {
  return Math.abs(a.startTime - b.startTime) < 1e-3 && Math.abs(a.duration - b.duration) < 1e-3;
}

/**
 * The optimistic-hold state machine, pure. Given the clip's CURRENT timing from
 * props (the server/cache value) and a HELD timing committed by the last drag,
 * decide what to display and whether the held value can now be released.
 *
 * - While a held value exists, DISPLAY it (so the bar never flashes back to the
 *   stale prop), UNTIL the incoming prop provably reflects it — then release
 *   (display the prop, drop the hold).
 * - No held value → display the prop directly.
 *
 * `held` is what the component stashed on release; `prop` is the latest timing
 * derived from the composition. Returns `{ display, release }` where `release`
 * is true once the hold is satisfied (the component should clear its held state).
 */
export function resolveHeldTiming(
  prop: ClipTiming,
  held: ClipTiming | null,
): { display: ClipTiming; release: boolean } {
  if (!held) return { display: prop, release: false };
  if (timingReflects(prop, held)) return { display: prop, release: true };
  return { display: held, release: false };
}

/** One vertical-stack row, identified by `id` and ordered by `key` — overlay
 *  rows use the overlay `z`, detached audio tracks use their `timelineOrder`.
 *  Both axes are SHARED so a detached track can sort among the overlays. */
export interface StackOrderRow {
  id: string;
  /** Sort key (overlay z OR audio order). Higher = nearer the TOP. */
  key: number;
  /** The row's vertical span in client space (for hit-testing the drop slot). */
  top: number;
  bottom: number;
}

/**
 * Fractional-indexing for a DETACHED audio track's vertical drag. Given the
 * ordered stack rows (each with its sort key + live client-space rect) and the
 * pointer Y, return the NEW `timelineOrder` for the dragged track so it lands in
 * the slot under the pointer — the MIDPOINT between the two neighbors at the drop
 * position. The dragged row is excluded from the neighbor search (so dropping it
 * back on itself is a no-op signalled by a null return).
 *
 * Edge handling:
 *  - above ALL other rows → topKey + 1
 *  - below ALL other rows → bottomKey − 1
 *  - between two rows → (upperKey + lowerKey) / 2
 *
 * `rows` need NOT be pre-sorted — they're sorted here by key DESCENDING (top→
 * bottom) so the geometry and the key order agree. Returns null when there are no
 * other rows to position against, or when the drop slot would leave the order
 * unchanged (dropping in the dragged row's own gap).
 */
export function orderForVerticalDrop(
  rows: StackOrderRow[],
  draggedId: string,
  clientY: number,
): number | null {
  const others = rows
    .filter((r) => r.id !== draggedId)
    .slice()
    .sort((a, b) => b.key - a.key); // top→bottom (descending key)
  if (others.length === 0) return null;

  // The drop slot is the index in `others` BEFORE which the dragged row lands:
  // the first row whose vertical MIDPOINT is at/under the pointer. Below all →
  // slot = others.length (after the last row).
  let slot = others.length;
  for (let i = 0; i < others.length; i++) {
    const mid = (others[i].top + others[i].bottom) / 2;
    if (clientY <= mid) {
      slot = i;
      break;
    }
  }

  if (slot === 0) return others[0].key + 1; // above all
  if (slot === others.length) return others[others.length - 1].key - 1; // below all
  // Between others[slot-1] (upper) and others[slot] (lower): the midpoint key.
  const upper = others[slot - 1].key;
  const lower = others[slot].key;
  return (upper + lower) / 2;
}
