import type { StoryboardCard } from "./types";

function selectedFileId(card: StoryboardCard | undefined): string | undefined {
  if (!card?.clips || !card.selectedClipId) return undefined;
  return card.clips.find((c) => c.id === card.selectedClipId && !c.hidden)?.fileId;
}

/** Returns a copy of `card` with each inherited ref resolved to the source
 *  card's selected-take fileId and injected into clipGen.params under the same
 *  key. Unresolvable refs (source missing / no selected take) are omitted, never
 *  left as a sentinel. Pure — used by storyboard_get enrichment. */
export function resolveInheritedRefs(card: StoryboardCard, all: StoryboardCard[]): StoryboardCard {
  if (!card.inheritedRefs || !card.clipGen) return card;
  const byId = new Map(all.map((c) => [c.id, c]));
  const params = { ...card.clipGen.params };
  for (const [key, ref] of Object.entries(card.inheritedRefs)) {
    const fileId = selectedFileId(byId.get(ref.fromCardId));
    if (fileId) params[key] = fileId;
    else delete params[key];
  }
  return { ...card, clipGen: { ...card.clipGen, params } };
}
