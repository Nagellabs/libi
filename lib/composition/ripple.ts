/**
 * Close a hole in the timeline: shift every overlay and audio clip that STARTS
 * at or after `fromTime + byDuration` left by `byDuration`.
 *
 * This is the "ripple delete" half of libi's two delete commands. Plain delete
 * leaves the gap (correct for layered compositing — removing a caption must not
 * drag the background); ripple delete removes the clip AND the time it occupied
 * (correct for sequential cut-down editing). Scenes used to get this free from
 * `sceneOrder`'s implicit positions; overlays carry absolute `startTime`, so it
 * has to be computed explicitly.
 *
 * Items that START BEFORE the gap are never moved, even when they extend past
 * it — they OVERLAP the deleted window rather than follow it. A full-length
 * background is the motivating case: shifting it would tear the composition.
 *
 * The shift is timeline-wide, not scoped to the deleted clip's `group`/lane —
 * libi has no sync-lock concept to express "shift this lane but not that one".
 *
 * Pure: no IO, no manifest save. Unit-tested without storage.
 */
import type { CompositionManifest } from "./persistence";

export function rippleCloseGap(
  m: CompositionManifest,
  fromTime: number,
  byDuration: number,
): CompositionManifest {
  if (!(byDuration > 0)) return m;
  const gapEnd = fromTime + byDuration;
  const shift = <T extends { startTime: number }>(item: T): T =>
    item.startTime >= gapEnd
      ? { ...item, startTime: Math.max(0, item.startTime - byDuration) }
      : item;
  return {
    ...m,
    overlays: (m.overlays ?? []).map(shift),
    audioClips: (m.audioClips ?? []).map(shift),
  };
}
