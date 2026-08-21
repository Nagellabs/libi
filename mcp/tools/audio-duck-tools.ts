/** Audio ducking MCP tool implementations. */

import {
  loadManifest,
  saveManifest,
} from "@/lib/composition/persistence";
import { updateClip as updateClipPure } from "@/lib/composition/audio-clips";
import { DEFAULT_DUCK, sanitizeDuck, validateDuck } from "@/lib/audio/duck-params";
import type { ToolContext, ToolResult } from "./types";
import type {
  AudioDuckEnableParams,
  AudioDuckDisableParams,
  AudioDuckUpdateParams,
} from "./schemas";

/**
 * The sidechain half of a duck patch, from either spelling. Returns `{}` when
 * the caller named no sidechain at all, so a spread leaves the existing set
 * alone. `sidechainClipIds` wins when both are present; the single-id form is
 * the deprecated alias kept for older skills and transcripts.
 */
function sidechainPatch(
  params: { sidechainClipIds?: string[]; sidechainClipId?: string },
): { sidechainClipIds: string[] } | Record<string, never> {
  if (params.sidechainClipIds) return { sidechainClipIds: params.sidechainClipIds };
  if (params.sidechainClipId !== undefined) return { sidechainClipIds: [params.sidechainClipId] };
  return {};
}

export async function audioDuckEnable(
  ctx: ToolContext,
  params: AudioDuckEnableParams,
): Promise<ToolResult> {
  const manifest = await loadManifest(ctx.pieceId);
  const clips = manifest.audioClips ?? [];
  const target = clips.find((c) => c.id === params.clipId);
  if (!target) return { success: false, error: `Clip ${params.clipId} not found` };

  const duck = sanitizeDuck({
    ...DEFAULT_DUCK,
    // `sidechainClipIds` wins; the single `sidechainClipId` is the deprecated
    // alias, normalized to a one-element list by sanitizeDuck.
    ...sidechainPatch(params),
    thresholdDb: params.thresholdDb ?? DEFAULT_DUCK.thresholdDb,
    ratio: params.ratio ?? DEFAULT_DUCK.ratio,
    attackMs: params.attackMs ?? DEFAULT_DUCK.attackMs,
    releaseMs: params.releaseMs ?? DEFAULT_DUCK.releaseMs,
    reductionDb: params.reductionDb ?? DEFAULT_DUCK.reductionDb,
  });
  // validateDuck handles: an empty sidechain list, self-duck, a missing
  // sidechain clip, AND cycle detection (direct + transitive). All four
  // cases are critical because ffmpeg's filter graph and Web Audio's
  // node graph both reject cycles.
  const v = validateDuck(duck, clips, params.clipId);
  if (!v.ok) return { success: false, error: v.error };

  const next = updateClipPure(manifest, params.clipId, { duck });
  if (!next) return { success: false, error: "Failed to update clip" };
  await saveManifest(ctx.pieceId, next);
  return { success: true, data: { clipId: params.clipId, duck } };
}

export async function audioDuckDisable(
  ctx: ToolContext,
  params: AudioDuckDisableParams,
): Promise<ToolResult> {
  const manifest = await loadManifest(ctx.pieceId);
  const target = (manifest.audioClips ?? []).find((c) => c.id === params.clipId);
  if (!target) return { success: false, error: `Clip ${params.clipId} not found` };
  if (!target.duck) return { success: true, data: { clipId: params.clipId, alreadyDisabled: true } };
  const next = updateClipPure(manifest, params.clipId, { duck: undefined });
  if (!next) return { success: false, error: "Failed to update clip" };
  await saveManifest(ctx.pieceId, next);
  return { success: true, data: { clipId: params.clipId } };
}

export async function audioDuckUpdate(
  ctx: ToolContext,
  params: AudioDuckUpdateParams,
): Promise<ToolResult> {
  const manifest = await loadManifest(ctx.pieceId);
  const target = (manifest.audioClips ?? []).find((c) => c.id === params.clipId);
  if (!target) return { success: false, error: `Clip ${params.clipId} not found` };
  if (!target.duck) {
    return {
      success: false,
      error: `Ducking is not enabled on clip ${params.clipId}; call audio_duck_enable first`,
    };
  }
  // A sidechain patch REPLACES the set; `sanitizeDuck` also normalizes a
  // legacy `sidechainClipId` still sitting on the stored duck.
  const merged = sanitizeDuck({
    ...target.duck,
    ...sidechainPatch(params),
    ...(params.thresholdDb !== undefined ? { thresholdDb: params.thresholdDb } : {}),
    ...(params.ratio !== undefined ? { ratio: params.ratio } : {}),
    ...(params.attackMs !== undefined ? { attackMs: params.attackMs } : {}),
    ...(params.releaseMs !== undefined ? { releaseMs: params.releaseMs } : {}),
    ...(params.reductionDb !== undefined ? { reductionDb: params.reductionDb } : {}),
  });
  // Only when the caller actually names sidechains — an unrelated param patch
  // on a piece whose sidechain was since deleted should still go through.
  if (params.sidechainClipIds || params.sidechainClipId !== undefined) {
    const v = validateDuck(merged, manifest.audioClips ?? [], params.clipId);
    if (!v.ok) return { success: false, error: v.error };
  }
  const next = updateClipPure(manifest, params.clipId, { duck: merged });
  if (!next) return { success: false, error: "Failed to update clip" };
  await saveManifest(ctx.pieceId, next);
  return { success: true, data: { clipId: params.clipId, duck: merged } };
}
