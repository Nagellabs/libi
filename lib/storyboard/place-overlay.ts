// lib/storyboard/place-overlay.ts
/**
 * Place a storyboard card's selected clip into the composition as a full-frame
 * VIDEO OVERLAY, then re-flow every storyboard-owned overlay so the cards stay
 * a back-to-back sequence.
 *
 * Replaces `placeCardScene`. Base scenes re-flowed implicitly through
 * `sceneOrder` — position was a function of order, so lengthening one card
 * pushed every later one for free. Overlays carry an absolute `startTime`, so
 * the storyboard has to compute that packing itself; that is what
 * `layoutSequentialOverlays` does here. Each overlay's inline audio clip is
 * moved with it — the storyboard is the one place where a duration change must
 * ripple through the whole timeline.
 *
 * OWNERSHIP IS DERIVED, NOT STORED. A storyboard-owned overlay is one whose id
 * equals `cardOverlayId(card)` for some card in the storyboard — exactly the
 * relation `placeCardScene` relied on for scenes. Deliberately NOT a
 * `fromCardId` field on `PersistedOverlay`: `libi.get_overlays` spreads
 * `...rest` over every overlay record, so any bookkeeping field we added there
 * would leak straight into the agent-facing response.
 */
import { loadManifest, saveManifest } from "@/lib/composition/persistence";
import type { PersistedOverlay } from "@/lib/composition/persistence";
import { loadStoryboard } from "./repo";
import { layoutSequentialOverlays } from "./sequence-layout";
import type { StoryboardCard } from "./types";

/** Deterministic overlay id for a storyboard card. Same key `placeCardScene`
 *  used for scenes, so a card keeps its identity across the scene→overlay
 *  retirement and re-placing a card updates in place instead of duplicating. */
export function cardOverlayId(card: StoryboardCard): string {
  return card.sceneId ?? `sb-${card.id}`;
}

/** The fileId to place on the timeline: the selected visible take, falling back
 *  to the legacy single clipFileId. */
export function selectedClipFileId(card: StoryboardCard): string | undefined {
  if (card.clips && card.selectedClipId) {
    const t = card.clips.find((c) => c.id === card.selectedClipId && !c.hidden);
    if (t) return t.fileId;
  }
  return card.clipFileId;
}

/** Upsert the card's clip as a full-frame video overlay, then re-flow all
 *  storyboard-owned overlays into a back-to-back sequence in `cardOrder`.
 *  Returns the overlay id, or null if the card has no clip to place.
 *  Mutates composition.json via saveManifest (draft flip). */
export async function placeCardOverlay(
  pieceId: string,
  card: StoryboardCard,
): Promise<string | null> {
  const fileId = selectedClipFileId(card);
  if (!fileId) return null;
  const overlayId = cardOverlayId(card);
  const sb = await loadStoryboard(pieceId);
  const manifest = await loadManifest(pieceId);
  const overlays = (manifest.overlays ?? []).slice();

  const overlay: PersistedOverlay = {
    id: overlayId,
    kind: "video",
    // Both corrected by the re-flow below; the values here only matter for a
    // piece with no storyboard manifest at all.
    startTime: 0,
    z: 0,
    duration: card.durationSec,
    rect: { x: 0, y: 0, width: manifest.width, height: manifest.height },
    opacity: 1,
    fileId,
    // Matches the retired video-scene→overlay conversion, so
    // migrated pieces and freshly-placed cards render identically. NB base
    // video SCENES letterboxed (`fitRect`) — full-frame cover is a deliberate
    // repo-wide choice for overlays, not an oversight.
    fit: "cover",
    displayName: card.title,
  };

  // REPLACE, don't merge — same as the `placeCardScene` this was ported from
  // (`scenes[existingIdx] = scene`). A merge looks kinder but is not: the new
  // record has no `trim` key, so a trim set against take v1 would survive
  // verbatim onto take v2 — a DIFFERENT file of a different length — and the
  // same goes for `transform3d` / `keyframes` / `anchor`. Meanwhile `rect` IS
  // in the new record, so a user resize is dropped regardless. Retaining an
  // arbitrary subset is worse than retaining none: re-placing a card is a
  // "make this overlay be this clip" operation, and the clip is the authority.
  const existingIdx = overlays.findIndex((o) => o.id === overlayId);
  if (existingIdx >= 0) overlays[existingIdx] = overlay;
  else overlays.push(overlay);

  // Storyboard-owned overlays, in cardOrder. Anything else on the track is a
  // user-added overlay and is left where it is.
  //
  // No storyboard manifest at all ⇒ nothing to sequence: leave `owned` empty so
  // the re-flow below is a no-op. Re-flowing the lone just-placed overlay to
  // `startTime: 0` would silently yank a user-positioned overlay back to the
  // head of the timeline; a brand-new overlay already starts at 0 from the
  // literal above, so there is nothing to gain by re-flowing it either.
  const owned: PersistedOverlay[] = [];
  if (sb) {
    for (const cardId of sb.cardOrder) {
      const c = cardId === card.id ? card : sb.cards.find((x) => x.id === cardId);
      if (!c) continue;
      const o = overlays.find((x) => x.id === cardOverlayId(c));
      if (o) owned.push(o);
    }
  }

  const startById = new Map(
    layoutSequentialOverlays(
      owned.map((o) => ({ overlayId: o.id, duration: o.duration })),
    ).map((p) => [p.overlayId, p.startTime]),
  );

  // Storyboard overlays sit at the BOTTOM of the stack in card order; any
  // non-storyboard overlay the user added keeps its position above them.
  const ownedIds = new Set(owned.map((o) => o.id));
  const rest = overlays.filter((o) => !ownedIds.has(o.id));
  // An overlay whose card was DELETED is no longer owned, but it is still a
  // storyboard artifact — keep it below the user's overlays rather than
  // promoting a stale clip on top of the entire strip. (The old scene path
  // sorted unknown scenes to the END, which was equally harmless.) The `sb-`
  // id prefix is the only signal available; ownership is derived, never stored,
  // so a card with a custom `sceneId` can't be recognized here.
  const isOrphan = (o: PersistedOverlay) => o.id.startsWith("sb-");
  // Sort by CURRENT `z`, never by array order: `reorderOverlaysInManifest`
  // rewrites `z` only and leaves the array in insertion order, so `z` is the
  // user's expressed stacking intent. Renumbering by array position would
  // silently invert a reorder the user just made.
  const byZ = (a: PersistedOverlay, b: PersistedOverlay) => a.z - b.z;
  const orphans = rest.filter(isOrphan).sort(byZ);
  const userAdded = rest.filter((o) => !isOrphan(o)).sort(byZ);

  const zById = new Map<string, number>();
  let z = 0;
  for (const o of owned) zById.set(o.id, z++);
  for (const o of orphans) zById.set(o.id, z++);
  for (const o of userAdded) zById.set(o.id, z++);

  manifest.overlays = overlays.map((o) => ({
    ...o,
    ...(startById.has(o.id) ? { startTime: startById.get(o.id)! } : {}),
    ...(zById.has(o.id) ? { z: zById.get(o.id)! } : {}),
  }));

  // Inline audio rides its overlay — otherwise a re-flow silently desyncs every
  // clip's sound from its picture.
  manifest.audioClips = (manifest.audioClips ?? []).map((c) =>
    c.linkedOverlayId && startById.has(c.linkedOverlayId)
      ? { ...c, startTime: startById.get(c.linkedOverlayId)! }
      : c,
  );

  await saveManifest(pieceId, manifest);
  return overlayId;
}
