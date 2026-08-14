import type { StoryboardCard, GeneratedClip } from "./types";

export function visibleTakes(card: StoryboardCard): GeneratedClip[] {
  return (card.clips ?? []).filter((c) => !c.hidden);
}

export function selectedTake(card: StoryboardCard): GeneratedClip | undefined {
  if (!card.selectedClipId) return undefined;
  return visibleTakes(card).find((c) => c.id === card.selectedClipId);
}

export function isOnTimeline(card: StoryboardCard): boolean {
  return !!selectedTake(card);
}
