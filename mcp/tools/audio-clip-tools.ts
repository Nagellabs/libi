/** Audio clip MCP tool implementations. */

import { eq, and } from "drizzle-orm";
import {
  loadManifest,
  saveManifest,
} from "@/lib/composition/persistence";
import {
  addClip,
  updateClip as updateClipPure,
  removeClip as removeClipPure,
  unlinkClip as unlinkClipPure,
  relinkClipToOverlay,
  splitClip as splitClipPure,
  findInlineClipForOverlay,
} from "@/lib/composition/audio-clips";

// Re-exported so the inline-audio overlay path (overlay-tools.ts) and tests can
// import the idempotency guard from the audio tool surface.
export { findInlineClipForOverlay };
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import type { ToolContext, ToolResult } from "./types";
import type {
  AudioAddClipParams,
  AudioUpdateClipParams,
  AudioRemoveClipParams,
  AudioUnlinkParams,
  AudioSplitParams,
  AudioRelinkOverlayParams,
} from "./schemas";

function randomId(): string {
  return Math.random().toString(36).substring(2, 10);
}

export async function audioAddClip(
  ctx: ToolContext,
  params: AudioAddClipParams,
): Promise<ToolResult> {
  const db = getDb();
  const [file] = db
    .select()
    .from(files)
    .where(and(eq(files.id, params.fileId), eq(files.pieceId, ctx.pieceId)))
    .limit(1)
    .all();
  if (!file) {
    return { success: false, error: `File ${params.fileId} not found for this piece` };
  }
  if (params.kind === "inline" && !params.linkedSceneId && !params.linkedOverlayId) {
    return { success: false, error: "kind='inline' requires linkedSceneId or linkedOverlayId" };
  }

  const manifest = await loadManifest(ctx.pieceId);
  const id = `clip_${randomId()}`;
  const next = addClip(manifest, {
    id,
    kind: params.kind,
    fileId: params.fileId,
    startTime: params.startTime,
    duration: params.duration ?? file.mediaDuration ?? 0,
    trimStart: params.trimStart ?? 0,
    volume: params.volume ?? 1,
    enabled: params.enabled ?? true,
    linkedSceneId: params.linkedSceneId,
    linkedOverlayId: params.linkedOverlayId,
    label: params.label,
  });
  await saveManifest(ctx.pieceId, next);
  return { success: true, data: { clipId: id } };
}

export async function audioUpdateClip(
  ctx: ToolContext,
  params: AudioUpdateClipParams,
): Promise<ToolResult> {
  const manifest = await loadManifest(ctx.pieceId);
  const patch: Record<string, unknown> = {};
  for (const k of ["startTime", "duration", "trimStart", "volume", "enabled", "label", "timelineOrder"] as const) {
    if (params[k] !== undefined) patch[k] = params[k];
  }
  const next = updateClipPure(manifest, params.clipId, patch);
  if (!next) return { success: false, error: `Audio clip ${params.clipId} not found` };
  await saveManifest(ctx.pieceId, next);
  return { success: true, data: { clipId: params.clipId, ...patch } };
}

export async function audioRemoveClip(
  ctx: ToolContext,
  params: AudioRemoveClipParams,
): Promise<ToolResult> {
  const manifest = await loadManifest(ctx.pieceId);
  const next = removeClipPure(manifest, params.clipId);
  if (!next) return { success: false, error: `Audio clip ${params.clipId} not found` };
  await saveManifest(ctx.pieceId, next);
  return { success: true, data: { clipId: params.clipId } };
}

export async function audioUnlink(
  ctx: ToolContext,
  params: AudioUnlinkParams,
): Promise<ToolResult> {
  const manifest = await loadManifest(ctx.pieceId);
  const next = unlinkClipPure(manifest, params.clipId);
  if (!next) return { success: false, error: `Inline clip ${params.clipId} not found or already standalone` };
  await saveManifest(ctx.pieceId, next);
  return { success: true, data: { clipId: params.clipId, kind: "standalone" } };
}

export async function audioRelinkOverlay(
  ctx: ToolContext,
  params: AudioRelinkOverlayParams,
): Promise<ToolResult> {
  const manifest = await loadManifest(ctx.pieceId);
  const next = relinkClipToOverlay(manifest, params.clipId, params.overlayId);
  if (!next)
    return {
      success: false,
      error: `Cannot relink clip ${params.clipId} to overlay ${params.overlayId} (clip or video overlay not found)`,
    };
  await saveManifest(ctx.pieceId, next);
  return { success: true, data: { clipId: params.clipId, kind: "inline", linkedOverlayId: params.overlayId } };
}

export async function audioSplit(
  ctx: ToolContext,
  params: AudioSplitParams,
): Promise<ToolResult> {
  const manifest = await loadManifest(ctx.pieceId);
  const next = splitClipPure(manifest, params.clipId, params.time);
  if (!next) {
    return { success: false, error: `Cannot split clip ${params.clipId} at t=${params.time} — outside clip range` };
  }
  await saveManifest(ctx.pieceId, next);
  const newClips = next.audioClips ?? [];
  const head = newClips.find((c) => c.id === params.clipId);
  const tail = newClips.find((c) => c.id !== params.clipId && c.startTime === params.time);
  return { success: true, data: { headId: head?.id, tailId: tail?.id } };
}
