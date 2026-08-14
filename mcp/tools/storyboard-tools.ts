// mcp/tools/storyboard-tools.ts
import type { ToolContext, ToolResult } from "./types";
import {
  loadStoryboard,
  loadCard,
  saveCard,
  getCardAbsolutePaths,
  attachCardArtifact,
  appendClipTake,
  selectClipTake,
  hideClipTake,
  setCardReference,
  addStoryboardCard as addCardToStoryboard,
  setCardGeneration,
  addSketch,
  removeSketch,
  reorderSketches,
  editSketch,
  updateCardFields,
  type NewCardInput,
  type CardPatch,
} from "@/lib/storyboard/repo";
import { placeCardOverlay } from "@/lib/storyboard/place-overlay";
import { renderCardSketches } from "@/lib/storyboard/render-card";
import { storyboardCostSummary } from "@/lib/storyboard/cost";
import { getModelSchemaCache } from "@/lib/storyboard/model-schema-cache";
import { resolveInheritedRefs } from "@/lib/storyboard/resolve-refs";
import { validateParams } from "@/lib/storyboard/gen-schema";
import { nearestAspectOption } from "@/lib/storyboard/param-catalog";
import { loadManifest } from "@/lib/composition/persistence";
import type { GenSpec } from "@/lib/storyboard/types";

export async function storyboardGet(
  params: { pieceId: string },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const sb = await loadStoryboard(params.pieceId);
  if (!sb) return { success: true, data: { storyboard: null, cardPaths: {}, costSummary: null } };
  const resolvedCards = sb.cards.map((c) => resolveInheritedRefs(c, sb.cards));
  const schemas: Record<string, { apiUrl: string; model: string; lookup: Awaited<ReturnType<typeof getModelSchemaCache>> }> = {};
  for (const c of resolvedCards) {
    for (const spec of [c.keyframeGen, c.clipGen]) {
      if (!spec || !spec.apiUrl) continue;
      const k = `${spec.apiUrl}::${spec.model}`;
      if (!schemas[k]) schemas[k] = { apiUrl: spec.apiUrl, model: spec.model, lookup: await getModelSchemaCache(spec.apiUrl, spec.model) };
    }
  }
  const cardPaths: Record<string, Awaited<ReturnType<typeof getCardAbsolutePaths>>> = {};
  for (const c of resolvedCards) cardPaths[c.id] = await getCardAbsolutePaths(params.pieceId, c.id);
  const enriched = { ...sb, cards: resolvedCards };
  return { success: true, data: { storyboard: enriched, cardPaths, schemas, costSummary: storyboardCostSummary(enriched) } };
}

/** Bootstrap/append a card. Initializes the storyboard manifest on the first
 *  call (the from-scratch entry point) and writes a default block-driven render
 *  unit so a Tier-1 schematic renders immediately. Returns the card + the
 *  absolute on-disk paths so the agent can refine it via file edits. */
export async function addStoryboardCard(
  params: {
    pieceId: string;
    card: NewCardInput;
    overview?: string;
    budgetUsd?: number;
  },
  _ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const card = await addCardToStoryboard(params.pieceId, params.card, {
      overview: params.overview,
      budgetUsd: params.budgetUsd,
    });
    const cardPaths = await getCardAbsolutePaths(params.pieceId, card.id);
    return { success: true, data: { cardId: card.id, stage: card.stage, card, cardPaths } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function attachStoryboardKeyframe(
  params: { pieceId: string; cardId: string; fileId: string; costUsd?: number },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const card = await attachCardArtifact(params.pieceId, params.cardId, "keyframe", params.fileId, params.costUsd);
  if (!card) return { success: false, error: `card not found: ${params.cardId}` };
  return { success: true, data: { cardId: card.id, stage: card.stage } };
}

export async function attachStoryboardClip(
  params: { pieceId: string; cardId: string; fileId: string; costUsd?: number },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const take = await appendClipTake(params.pieceId, params.cardId, params.fileId, params.costUsd);
  if (!take) return { success: false, error: `card not found: ${params.cardId}` };
  return { success: true, data: { cardId: params.cardId, take } };
}

/** Gated stage advance. Keyframe/clip generation is agent-driven: the agent
 *  calls fal via the ai-asset-generation/ai-video-models skills, then calls
 *  libi.attach_storyboard_keyframe / libi.attach_storyboard_clip to record the
 *  produced file. This tool only flips the approval + advances the stage (clip
 *  approval places the scene on the timeline). */
export async function setStoryboardGeneration(
  params: { pieceId: string; cardId: string; tier: "keyframe" | "clip"; spec: GenSpec },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const rawSpec = params.spec;
  const cache = await getModelSchemaCache(rawSpec.apiUrl, rawSpec.model);
  if (!cache.exists || cache.stale || !cache.schema) {
    return {
      success: false,
      error: "schema cache missing or stale",
      data: {
        error: "schema_cache_missing",
        apiUrl: rawSpec.apiUrl,
        model: rawSpec.model,
        hint: "Fetch this endpoint's API schema and call libi.save_model_schema_cache, then retry.",
      },
    };
  }
  // Default aspect_ratio to the PIECE's own aspect (nearest option this
  // endpoint actually declares) when the caller didn't set one explicitly.
  // Every card's clip lands as a full-frame `fit: "cover"` overlay
  // (lib/storyboard/place-overlay.ts) — a take generated in the wrong shape
  // is silently CROPPED to the piece's aspect with no visual cue (unlike the
  // old letterboxed base-video-scene path), so an unset aspect_ratio is a
  // quiet failure mode, not a neutral one. This only fills a genuine gap: an
  // explicit agent/user choice (including a deliberately mismatched one)
  // always wins because we only touch `params.aspect_ratio` when it is
  // `undefined`.
  const aspectField = cache.schema.fields.find((f) => f.key === "aspect_ratio");
  let spec = rawSpec;
  if (aspectField && spec.params.aspect_ratio === undefined) {
    const manifest = await loadManifest(params.pieceId);
    const defaultAspect = nearestAspectOption(manifest.width, manifest.height, aspectField.options);
    if (defaultAspect != null) {
      spec = { ...spec, params: { ...spec.params, aspect_ratio: defaultAspect } };
    }
  }
  const issues = validateParams(spec.params, cache.schema.fields);
  if (issues.length) {
    return {
      success: false,
      error: "schema validation failed",
      data: { error: "schema_validation_failed", issues } as Record<string, unknown>,
    };
  }
  const card = await setCardGeneration(params.pieceId, params.cardId, params.tier, spec);
  if (!card) return { success: false, error: `card not found: ${params.cardId}` };
  // The spec carries aspect_ratio; re-render the schematics so they pick up the
  // card's true frame (e.g. a 16:9 clip gets a 16:9 sketch, not the 9:16 default)
  // even when the agent set the spec without re-editing a unit file. Best-effort.
  try {
    await renderCardSketches(params.pieceId, card);
  } catch {
    // non-fatal: a sketch without a unit file yet is skipped; never block the spec write
  }
  return { success: true, data: { cardId: card.id, tier: params.tier } };
}

export async function selectStoryboardTake(
  params: { pieceId: string; cardId: string; takeId: string },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const card = await selectClipTake(params.pieceId, params.cardId, params.takeId);
  if (!card) return { success: false, error: "card or take not found" };
  if (card.selectedClipId) await placeCardOverlay(params.pieceId, card);
  return { success: true, data: { cardId: card.id, selectedClipId: card.selectedClipId } };
}

export async function hideStoryboardTake(
  params: { pieceId: string; cardId: string; takeId: string },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const card = await hideClipTake(params.pieceId, params.cardId, params.takeId);
  if (!card) return { success: false, error: "card not found" };
  return { success: true, data: { cardId: card.id, selectedClipId: card.selectedClipId } };
}

export async function setStoryboardReference(
  params: { pieceId: string; cardId: string; paramKey: string; fromCardId: string },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const card = await setCardReference(params.pieceId, params.cardId, params.paramKey, { fromCardId: params.fromCardId });
  if (!card) return { success: false, error: "card not found" };
  return { success: true, data: { cardId: card.id } };
}

export async function editStoryboardCard(
  params: {
    pieceId: string;
    cardId: string;
    addSketch?: { role: "start" | "end" | "reference"; paramKey: string; label?: string };
    removeSketch?: { slotId: string };
    reorderSketches?: { order: string[] };
    editSketch?: { slotId: string; paramKey?: string; role?: "start" | "end" | "reference"; label?: string };
    fields?: Partial<{
      title: string; description: string; promptFragment: string; durationSec: number;
      role: string; voiceover: { line: string; voice?: string };
      camera: { shot: "extreme-wide" | "wide" | "medium" | "close" | "extreme-close"; motion?: string };
    }>;
  },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const { pieceId, cardId } = params;
  const exists = await loadCard(pieceId, cardId);
  if (!exists) return { success: false, error: `card not found: ${cardId}` };

  if (params.fields && Object.keys(params.fields).length) {
    await updateCardFields(pieceId, cardId, params.fields as CardPatch);
  }
  if (params.removeSketch) await removeSketch(pieceId, cardId, params.removeSketch.slotId);
  if (params.reorderSketches) await reorderSketches(pieceId, cardId, params.reorderSketches.order);
  if (params.editSketch) {
    const { slotId, ...patch } = params.editSketch;
    const res = await editSketch(pieceId, cardId, slotId, patch);
    if (!res) return { success: false, error: `editSketch failed — unknown slot ${slotId} on card ${cardId}` };
  }

  let added: { slotId: string; unit: string } | undefined;
  if (params.addSketch) {
    const res = await addSketch(pieceId, cardId, params.addSketch);
    if (!res) return { success: false, error: `addSketch failed for card: ${cardId}` };
    const paths = await getCardAbsolutePaths(pieceId, cardId);
    const unit = paths.sketches.find((s) => s.slotId === res.slot.id)?.unit ?? "";
    added = { slotId: res.slot.id, unit };
  }

  const card = await loadCard(pieceId, cardId);
  return { success: true, data: { cardId, sketch: added, sketches: card?.sketches ?? [] } };
}

export async function approveStoryboardStage(
  params: { pieceId: string; cardId: string; stage: "schematic" | "keyframe" | "clip" },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const card = await loadCard(params.pieceId, params.cardId);
  if (!card) return { success: false, error: `card not found: ${params.cardId}` };
  // Enforce ladder gating. The only hard gate is the free schematic — the
  // review-before-spend rung. The keyframe is OPTIONAL: a clip may be generated
  // without one (prompt/text-to-video), so `clip` requires only the schematic,
  // not an approved keyframe.
  if (params.stage === "keyframe" && !card.approvals.schematic) {
    return { success: false, error: "schematic must be approved before keyframe" };
  }
  if (params.stage === "clip" && !card.approvals.schematic) {
    return { success: false, error: "schematic must be approved before clip" };
  }
  card.approvals[params.stage] = true;
  await saveCard(params.pieceId, card);
  if (params.stage === "clip") {
    await placeCardOverlay(params.pieceId, card);
  }
  return { success: true, data: { cardId: card.id, approvals: card.approvals } };
}
