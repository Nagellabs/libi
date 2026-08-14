import type { StoryboardCard } from "./types";

/** Pure: has the clip spec been edited since the take currently shown/selected
 *  was generated? Used to render a "regenerate to apply" hint. Returns false when
 *  there is no clipGen, no editedAt, or no take to be stale against. */
export function isClipStale(card: StoryboardCard): boolean {
  const editedAt = card.clipGen?.editedAt;
  if (editedAt == null) return false;
  const visible = (card.clips ?? []).filter((c) => !c.hidden);
  if (visible.length === 0) return false;
  const reference =
    visible.find((c) => c.id === card.selectedClipId) ??
    visible[visible.length - 1];
  return editedAt > reference.createdAt;
}
