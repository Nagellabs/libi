import fs from "fs/promises";
import { getStorage } from "@/lib/storage";
import { parseCard, parseStoryboard } from "./zod";
import type {
  Block,
  CameraMotion,
  GeneratedClip,
  GenParamValue,
  GenSpec,
  InheritedRef,
  RenderUnitRef,
  SketchRole,
  SketchSlot,
  ShotSize,
  Storyboard,
  StoryboardCard,
  StoryboardManifest,
} from "./types";
import {
  STORYBOARD_DIR,
  STORYBOARD_MANIFEST,
  cardJsonPath,
  cardDir,
  cardRenderPath,
  slotUnitPath,
  slotSketchPath,
  cardSketchesDir,
} from "./paths";
import { migrateRawCardSketches } from "./migrate-sketches";
import { DEFAULT_ROUGH_RENDER } from "./default-render-unit";
import { withStoryboardLock } from "./lock";

/** Lazy, idempotent migration: lift legacy single-file artifacts into the
 *  versioned clips list + keyframeGen spec. A card that already has `clips`
 *  (or has neither legacy nor new artifacts) is returned unchanged. */
export function migrateCardGeneration(card: StoryboardCard): StoryboardCard {
  let next = card;
  if (card.clips === undefined && card.clipFileId) {
    const take = {
      id: `take_${card.id}_1`,
      fileId: card.clipFileId,
      label: "v1",
      createdAt: 0,
    };
    next = { ...next, clips: [take], selectedClipId: next.selectedClipId ?? take.id };
  }
  if (card.keyframeGen === undefined && card.keyframeFileId) {
    next = {
      ...next,
      keyframeGen: { apiUrl: "", model: "", params: { start_frame: card.keyframeFileId } },
    };
  }
  return next;
}

export async function loadStoryboard(pieceId: string): Promise<Storyboard | null> {
  const storage = await getStorage();
  if (!(await storage.exists(pieceId, STORYBOARD_MANIFEST))) return null;
  const manifest = parseStoryboard(
    JSON.parse((await storage.read(pieceId, STORYBOARD_MANIFEST)).toString("utf8")),
  ) as StoryboardManifest;
  const cards: StoryboardCard[] = [];
  for (const id of manifest.cardOrder) {
    if (!(await storage.exists(pieceId, cardJsonPath(id)))) continue;
    cards.push(
      migrateCardGeneration(
        parseCard(
          migrateRawCardSketches(
            JSON.parse((await storage.read(pieceId, cardJsonPath(id))).toString("utf8")),
          ),
        ),
      ),
    );
  }
  return { ...manifest, cards };
}

/** Unlocked full write: every card.json + the manifest, and removal of card dirs
 *  not in `sb`. Only ever call it while holding the piece's storyboard lock with
 *  an `sb` loaded under that same hold — a stale `sb` overwrites every card and
 *  deletes any card added since it was loaded. */
async function writeStoryboard(pieceId: string, sb: Storyboard): Promise<void> {
  const storage = await getStorage();
  const manifest: StoryboardManifest = {
    version: 2,
    overview: sb.overview,
    cardOrder: sb.cards.map((c) => c.id),
    edges: sb.edges,
    updatedAt: new Date().toISOString(),
    budgetUsd: sb.budgetUsd,
    layout: sb.layout,
  };
  // Remove orphaned card dirs (cards present on disk but not in the new set).
  const keep = new Set(sb.cards.map((c) => c.id));
  const cardsBaseDir = storage.localPath(pieceId, "storyboard/cards");
  try {
    const existingCardIds = await fs.readdir(cardsBaseDir);
    for (const existingId of existingCardIds) {
      if (!keep.has(existingId)) {
        await fs.rm(storage.localPath(pieceId, cardDir(existingId)), {
          recursive: true,
          force: true,
        });
      }
    }
  } catch {
    // storyboard/cards dir doesn't exist yet — nothing to clean up
  }
  for (const card of sb.cards) {
    await storage.save(
      pieceId,
      cardJsonPath(card.id),
      Buffer.from(JSON.stringify(card, null, 2)),
      "application/json",
    );
  }
  await storage.save(
    pieceId,
    STORYBOARD_MANIFEST,
    Buffer.from(JSON.stringify(manifest, null, 2)),
    "application/json",
  );
}

/** Blind overwrite of the whole storyboard with `sb` (e.g. restoring a
 *  snapshot). Serialized with every other storyboard write, but `sb` is written
 *  as given — for a read-modify-write use `mutateStoryboard`, which loads under
 *  the lock. */
export async function saveStoryboard(pieceId: string, sb: Storyboard): Promise<void> {
  await withStoryboardLock(pieceId, () => writeStoryboard(pieceId, sb));
}

/** What a mutation callback returns: `result` goes back to the caller; `next`,
 *  when present, is written. Omit `next` for a no-op (nothing is rewritten). */
export type Mutation<S, T> = { next?: S; result: T };

/** The one way to read-modify-write the WHOLE storyboard: load → `fn` → save,
 *  all under the piece's storyboard lock (see `./lock` — it serializes the Next
 *  server and the MCP child, which both write storyboard storage). `fn` gets the
 *  board as it is on disk NOW (null when the piece has none). Keep `fn` to pure
 *  mutation plus small local file writes — never renders, generation or network,
 *  and never call another locking repo function from inside it. */
export async function mutateStoryboard<T>(
  pieceId: string,
  fn: (sb: Storyboard | null) => Promise<Mutation<Storyboard, T>> | Mutation<Storyboard, T>,
): Promise<T> {
  return withStoryboardLock(pieceId, async () => {
    const { next, result } = await fn(await loadStoryboard(pieceId));
    if (next) await writeStoryboard(pieceId, next);
    return result;
  });
}

/** Per-card read-modify-write under the same lock as `mutateStoryboard` (a card
 *  write must not interleave with a whole-board write either). `fn` gets the
 *  card as it is on disk now, or null when it doesn't exist. Same rules for `fn`. */
export async function mutateCard<T>(
  pieceId: string,
  cardId: string,
  fn: (card: StoryboardCard | null) => Promise<Mutation<StoryboardCard, T>> | Mutation<StoryboardCard, T>,
): Promise<T> {
  return withStoryboardLock(pieceId, async () => {
    const { next, result } = await fn(await loadCard(pieceId, cardId));
    if (next) await writeCard(pieceId, next);
    return result;
  });
}

export async function loadCard(pieceId: string, cardId: string): Promise<StoryboardCard | null> {
  const storage = await getStorage();
  if (!(await storage.exists(pieceId, cardJsonPath(cardId)))) return null;
  return migrateCardGeneration(
    parseCard(
      migrateRawCardSketches(
        JSON.parse((await storage.read(pieceId, cardJsonPath(cardId))).toString("utf8")),
      ),
    ),
  );
}

/** Blind overwrite of one card.json, serialized with every other storyboard
 *  write. For a read-modify-write use `mutateCard`. */
export async function saveCard(pieceId: string, card: StoryboardCard): Promise<void> {
  await withStoryboardLock(pieceId, () => writeCard(pieceId, card));
}

async function writeCard(pieceId: string, card: StoryboardCard): Promise<void> {
  const storage = await getStorage();
  await storage.save(
    pieceId,
    cardJsonPath(card.id),
    Buffer.from(JSON.stringify(card, null, 2)),
    "application/json",
  );
}

/** Set a produced artifact (keyframe/clip) + its cost on a card and advance the
 *  stage. Returns the updated card, or null when the card doesn't exist. */
export async function attachCardArtifact(
  pieceId: string,
  cardId: string,
  artifact: "keyframe" | "clip",
  fileId: string,
  costUsd?: number,
): Promise<StoryboardCard | null> {
  return mutateCard(pieceId, cardId, (card) => {
    if (!card) return { result: null };
    if (artifact === "keyframe") {
      card.keyframeFileId = fileId;
      card.stage = "keyframe";
      if (costUsd !== undefined) card.cost = { ...card.cost, keyframeUsd: costUsd };
    } else {
      card.clipFileId = fileId;
      card.stage = "clip";
      if (costUsd !== undefined) card.cost = { ...card.cost, clipUsd: costUsd };
    }
    return { next: card, result: card };
  });
}

/** Authorable fields for a brand-new card (the bootstrap path). Everything
 *  ladder-owned (stage, approvals, keyframe/clip ids, cost, order) is derived. */
export type NewCardInput = {
  id?: string;
  title: string;
  role?: string;
  kind?: string;
  durationSec?: number;
  description?: string;
  voiceover?: { line: string; voice?: string };
  camera?: { shot: ShotSize; motion?: CameraMotion };
  promptFragment?: string;
  blocks?: Block[];
  render?: RenderUnitRef;
};

/** Create a card from scratch, initializing the storyboard manifest on the
 *  first call. This is the deliberate bootstrap entry point — the only "create"
 *  operation — so an agent never has to hand-author the manifest/card schema to
 *  start a board on a fresh piece. Subsequent structural edits stay file-based.
 *  Writes a default rough-canvas sketch unit (so a schematic renders immediately)
 *  unless the unit file already exists. Returns the created card. */
export async function addStoryboardCard(
  pieceId: string,
  input: NewCardInput,
  manifestFields?: { overview?: string; budgetUsd?: number },
): Promise<StoryboardCard> {
  return mutateStoryboard(pieceId, async (loaded) => {
    const sb: Storyboard =
      loaded ?? {
        version: 2,
        cardOrder: [],
        updatedAt: new Date().toISOString(),
        cards: [],
      };
    const order = sb.cards.length;
    const id = input.id?.trim() || `card_${order + 1}`;
    if (sb.cards.some((c) => c.id === id)) {
      throw new Error(`card id already exists: ${id}`);
    }
    const render: RenderUnitRef = input.render ?? { kind: "canvas", file: "sketches/sk_1/unit.jsx" };
    const card: StoryboardCard = {
      id,
      order,
      durationSec: input.durationSec ?? 5,
      role: input.role ?? "scene",
      kind: input.kind ?? "ai-video",
      title: input.title,
      description: input.description,
      voiceover: input.voiceover,
      sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render }],
      blocks: input.blocks,
      camera: input.camera ?? { shot: "medium" },
      promptFragment: input.promptFragment ?? input.description ?? input.title,
      stage: "schematic",
      approvals: {},
    };
    // Write the render unit BEFORE the storyboard write so the watcher (fired by
    // the card.json write) finds it and renders schematic.png on the first save.
    // Only write a default when no unit file exists (a caller may pre-author one).
    const storage = await getStorage();
    const unitRel = cardRenderPath(id, render.file);
    if (!(await storage.exists(pieceId, unitRel))) {
      await storage.save(pieceId, unitRel, Buffer.from(DEFAULT_ROUGH_RENDER), "text/plain");
    }
    return {
      next: {
        ...sb,
        overview: manifestFields?.overview ?? sb.overview,
        budgetUsd: manifestFields?.budgetUsd ?? sb.budgetUsd,
        cards: [...sb.cards, card],
      },
      result: card,
    };
  });
}

/** Whitelisted card fields the UI/agent may PATCH. */
export type CardPatch = Partial<Pick<StoryboardCard,
  "title" | "description" | "promptFragment" | "blocks" | "camera" | "durationSec" | "voiceover" | "role">>;

export async function updateCardFields(
  pieceId: string, cardId: string, patch: CardPatch,
): Promise<StoryboardCard | null> {
  return mutateCard(pieceId, cardId, (card) => {
    if (!card) return { result: null };
    // Explicitly pick ONLY whitelisted keys so a raw HTTP PATCH cannot overwrite
    // ladder-owned fields (id, stage, approvals, keyframeFileId, clipFileId,
    // cost, sceneId, etc.).
    const ALLOWED_KEYS = [
      "title", "description", "promptFragment", "blocks",
      "camera", "durationSec", "voiceover", "role",
    ] as const;
    const next: StoryboardCard = { ...card };
    for (const key of ALLOWED_KEYS) {
      if (patch[key] !== undefined) {
        // @ts-expect-error key is a valid StoryboardCard field
        next[key] = patch[key];
      }
    }
    return { next, result: next };
  });
}

export async function updateManifestLayout(
  pieceId: string, layout: { positions: Record<string, { x: number; y: number }> },
): Promise<void> {
  await mutateStoryboard(pieceId, (sb) => (sb ? { next: { ...sb, layout }, result: undefined } : { result: undefined }));
}

/** Remove all storyboard files for a piece (used by discard when there is no
 *  committed storyboard snapshot to restore). */
export async function clearStoryboard(pieceId: string): Promise<void> {
  await withStoryboardLock(pieceId, async () => {
    const storage = await getStorage();
    await fs.rm(storage.localPath(pieceId, STORYBOARD_DIR), { recursive: true, force: true });
  });
}

export async function setCardGeneration(
  pieceId: string,
  cardId: string,
  tier: "keyframe" | "clip",
  spec: GenSpec,
): Promise<StoryboardCard | null> {
  return mutateCard(pieceId, cardId, (card) => {
    if (!card) return { result: null };
    const next: StoryboardCard =
      tier === "keyframe" ? { ...card, keyframeGen: spec } : { ...card, clipGen: spec };
    return { next, result: next };
  });
}

/** Set or clear a single generation param on a tier's spec, stamping editedAt
 *  (drives the stale hint). `value === null` deletes the key (keeping the
 *  unset-params-never-render invariant). Returns null if the card or the tier's
 *  spec is missing — the agent must author the spec before params can be edited. */
export async function updateGenParam(
  pieceId: string,
  cardId: string,
  tier: "keyframe" | "clip",
  paramKey: string,
  value: GenParamValue | null,
): Promise<StoryboardCard | null> {
  return mutateCard(pieceId, cardId, (card) => {
    if (!card) return { result: null };
    const spec = tier === "keyframe" ? card.keyframeGen : card.clipGen;
    if (!spec) return { result: null };
    const params = { ...spec.params };
    if (value === null) delete params[paramKey];
    else params[paramKey] = value;
    const nextSpec: GenSpec = { ...spec, params, editedAt: Date.now() };
    const next: StoryboardCard =
      tier === "keyframe" ? { ...card, keyframeGen: nextSpec } : { ...card, clipGen: nextSpec };
    return { next, result: next };
  });
}

/** Append a generated clip as the next vN take. Auto-selects it if no take is
 *  selected yet. Deterministic id from existing take count. */
export async function appendClipTake(
  pieceId: string,
  cardId: string,
  fileId: string,
  costUsd?: number,
): Promise<GeneratedClip | null> {
  return mutateCard(pieceId, cardId, (card) => {
    if (!card) return { result: null };
    const clips = card.clips ?? [];
    const n = clips.length + 1;
    const take: GeneratedClip = {
      id: `take_${cardId}_${n}`,
      fileId,
      label: `v${n}`,
      createdAt: Date.now(),
    };
    const next: StoryboardCard = {
      ...card,
      clips: [...clips, take],
      selectedClipId: card.selectedClipId ?? take.id,
      cost: costUsd !== undefined ? { ...card.cost, clipUsd: costUsd } : card.cost,
    };
    return { next, result: take };
  });
}

export async function selectClipTake(
  pieceId: string,
  cardId: string,
  takeId: string,
): Promise<StoryboardCard | null> {
  return mutateCard(pieceId, cardId, (card) => {
    if (!card || !card.clips?.some((c) => c.id === takeId && !c.hidden)) return { result: null };
    const next = { ...card, selectedClipId: takeId };
    return { next, result: next };
  });
}

/** Soft-hide a take. If the hidden take was selected, reselect the newest
 *  remaining visible take (or clear selection if none remain). */
export async function hideClipTake(
  pieceId: string,
  cardId: string,
  takeId: string,
): Promise<StoryboardCard | null> {
  return mutateCard(pieceId, cardId, (card) => {
    if (!card?.clips) return { result: null };
    const clips = card.clips.map((c) => (c.id === takeId ? { ...c, hidden: true } : c));
    let selectedClipId = card.selectedClipId;
    if (selectedClipId === takeId) {
      const visible = clips.filter((c) => !c.hidden);
      selectedClipId = visible.length ? visible[visible.length - 1].id : undefined;
    }
    const next = { ...card, clips, selectedClipId };
    return { next, result: next };
  });
}

export async function setCardReference(
  pieceId: string,
  cardId: string,
  paramKey: string,
  ref: InheritedRef,
): Promise<StoryboardCard | null> {
  return mutateCard(pieceId, cardId, (card) => {
    if (!card) return { result: null };
    const next = {
      ...card,
      inheritedRefs: { ...card.inheritedRefs, [paramKey]: ref },
    };
    return { next, result: next };
  });
}

/** Remove a single inherited-reference link. No-op (returns the card) if absent. */
export async function clearCardReference(
  pieceId: string,
  cardId: string,
  paramKey: string,
): Promise<StoryboardCard | null> {
  return mutateCard(pieceId, cardId, (card) => {
    if (!card) return { result: null };
    if (!card.inheritedRefs?.[paramKey]) return { result: card };
    const inheritedRefs = { ...card.inheritedRefs };
    delete inheritedRefs[paramKey];
    const next = { ...card, inheritedRefs };
    return { next, result: next };
  });
}

/** Absolute on-disk paths the agent edits directly (file-as-source-of-truth). */
export async function getCardAbsolutePaths(
  pieceId: string,
  cardId: string,
): Promise<{
  cardJson: string;
  sketches: { slotId: string; role: string; paramKey: string; unit: string; sketch: string }[];
}> {
  const storage = await getStorage();
  const card = await loadCard(pieceId, cardId);
  const sketches = (card?.sketches ?? []).map((s) => ({
    slotId: s.id,
    role: s.role,
    paramKey: s.paramKey,
    unit: storage.localPath(pieceId, slotUnitPath(cardId, s)),
    sketch: storage.localPath(pieceId, `${cardSketchesDir(cardId)}/${s.id}.png`),
  }));
  return { cardJson: storage.localPath(pieceId, cardJsonPath(cardId)), sketches };
}

/** Next free `sk_N` id for a card. */
function nextSketchId(card: StoryboardCard): string {
  const used = new Set(card.sketches.map((s) => s.id));
  let n = card.sketches.length + 1;
  while (used.has(`sk_${n}`)) n++;
  return `sk_${n}`;
}

/** Append a role-tagged sketch slot bound to `paramKey`, scaffolding a default
 *  rough-canvas sketch unit so a sketch renders immediately. The agent refines
 *  the drawing by editing the returned unit path. Returns the card + new slot. */
export async function addSketch(
  pieceId: string,
  cardId: string,
  input: { role: SketchRole; paramKey: string; label?: string },
): Promise<{ card: StoryboardCard; slot: SketchSlot } | null> {
  return mutateCard(pieceId, cardId, async (card) => {
    if (!card) return { result: null };
    const id = nextSketchId(card);
    const slot: SketchSlot = {
      id,
      role: input.role,
      paramKey: input.paramKey,
      label: input.label,
      render: { kind: "canvas", file: `sketches/${id}/unit.jsx` },
    };
    const storage = await getStorage();
    const unitRel = slotUnitPath(cardId, slot);
    if (!(await storage.exists(pieceId, unitRel))) {
      await storage.save(pieceId, unitRel, Buffer.from(DEFAULT_ROUGH_RENDER), "text/plain");
    }
    const next: StoryboardCard = { ...card, sketches: [...card.sketches, slot] };
    return { next, result: { card: next, slot } };
  });
}

/** Remove a sketch slot and its on-disk unit dir + rendered png. Leaves the
 *  bound clip-gen param untouched (the realized image is managed separately). */
export async function removeSketch(
  pieceId: string,
  cardId: string,
  slotId: string,
): Promise<StoryboardCard | null> {
  return withStoryboardLock(pieceId, async () => {
    const card = await loadCard(pieceId, cardId);
    if (!card) return null;
    if (!card.sketches.some((s) => s.id === slotId)) return card; // no-op on unknown slot
    const next: StoryboardCard = { ...card, sketches: card.sketches.filter((s) => s.id !== slotId) };
    await writeCard(pieceId, next);
    const storage = await getStorage();
    // Only the slot's CANONICAL per-slot artifacts are removed: the `sketches/<id>/`
    // unit dir and the `sketches/<id>.png` render. We deliberately do NOT derive the
    // dir from slotUnitPath — a legacy slot whose render file sits at the card root
    // (e.g. `render.jsx`) would resolve to the card dir, and a recursive rm there
    // would destroy card.json. Leaving such a stray unit file is the safe trade-off.
    await fs.rm(storage.localPath(pieceId, `${cardSketchesDir(cardId)}/${slotId}`), { recursive: true, force: true });
    await fs.rm(storage.localPath(pieceId, slotSketchPath(cardId, slotId)), { force: true });
    return next;
  });
}

/** Reorder a card's sketch slots to match `order` (a permutation of slot ids).
 *  Ids not present in `order` are appended in their existing relative order. */
export async function reorderSketches(
  pieceId: string,
  cardId: string,
  order: string[],
): Promise<StoryboardCard | null> {
  return mutateCard(pieceId, cardId, (card) => {
    if (!card) return { result: null };
    const byId = new Map(card.sketches.map((s) => [s.id, s]));
    const ordered: SketchSlot[] = [];
    for (const id of order) {
      const s = byId.get(id);
      if (s) { ordered.push(s); byId.delete(id); }
    }
    for (const s of card.sketches) if (byId.has(s.id)) ordered.push(s);
    const next: StoryboardCard = { ...card, sketches: ordered };
    return { next, result: next };
  });
}

/** Re-key/edit an existing sketch slot: change its `paramKey` (to the model's real
 *  clip-gen param it conditions, e.g. `image_url`), `role`, `label`, or
 *  `imageFileId` (an imported image used AS the sketch — pass `null` to clear it
 *  and fall back to the rendered unit). Only the provided fields change; the slot's
 *  id and render unit are untouched. No-op on unknown id. */
export async function editSketch(
  pieceId: string,
  cardId: string,
  slotId: string,
  patch: { paramKey?: string; role?: SketchRole; label?: string; imageFileId?: string | null },
): Promise<{ card: StoryboardCard; slot: SketchSlot } | null> {
  return mutateCard(pieceId, cardId, (card) => {
    if (!card) return { result: null };
    const idx = card.sketches.findIndex((s) => s.id === slotId);
    if (idx === -1) return { result: null }; // unknown slot — caller surfaces the error
    const prev = card.sketches[idx];
    const slot: SketchSlot = {
      ...prev,
      ...(patch.paramKey !== undefined ? { paramKey: patch.paramKey } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.label !== undefined ? { label: patch.label } : {}),
    };
    if (patch.imageFileId !== undefined) {
      if (patch.imageFileId === null) delete slot.imageFileId;
      else slot.imageFileId = patch.imageFileId;
    }
    const sketches = card.sketches.slice();
    sketches[idx] = slot;
    const next: StoryboardCard = { ...card, sketches };
    return { next, result: { card: next, slot } };
  });
}
