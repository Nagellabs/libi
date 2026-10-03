/** Composition-level tool implementations */

import { inArray } from "drizzle-orm";
import { loadComposition } from "@/lib/composition/persistence";
import { renderTimeline, type TimelineFile, type TimelinePieceInput } from "@/lib/composition/timeline-view";
import { getDb } from "@/lib/db/client";
import { files, pieces } from "@/lib/db/schema/sqlite";
import { effectiveRights } from "@/lib/audio-rights/read";
import { toAgentOverlayRecord } from "@/lib/overlays/code-files";
import { resolvePieceTargets } from "./multi-piece-targets";
import type { GetCompositionParams } from "./schemas";
import type { ToolContext, ToolResult } from "./types";

/**
 * get_composition — the piece's manifest as the agent sees it. Like
 * get_overlays, code-bearing overlays (code/three/tracked-code) carry an
 * absolute `codeFilePath` instead of their hydrated JS body: the agent reads
 * and edits that file directly, and the manifest stays small.
 */
export async function getComposition(ctx: ToolContext): Promise<ToolResult> {
  const { manifest } = await loadComposition(ctx.pieceId);
  const overlays = manifest.overlays
    ? await Promise.all(manifest.overlays.map((o) => toAgentOverlayRecord(ctx.pieceId, o)))
    : undefined;
  return {
    success: true,
    data: {
      manifest: {
        ...(manifest as unknown as Record<string, unknown>),
        ...(overlays ? { overlays } : {}),
      },
    },
  };
}

/**
 * get_composition's entry point: the full manifest of ONE piece (the default), or the compact timeline of
 * one or several (`view: "timeline"`, `pieceIds`, `folderId`).
 */
export async function getCompositionTool(params: GetCompositionParams): Promise<ToolResult> {
  const multi = params.pieceIds !== undefined || params.folderId !== undefined;
  const view = params.view ?? (multi ? "timeline" : "full");
  if (view === "full") {
    if (multi) return { success: false, error: 'pieceIds and folderId read several pieces: pass view: "timeline" (the full manifest is one piece at a time).' };
    if (!params.pieceId) return { success: false, error: "Give pieceId (or pieceIds / folderId with view: \"timeline\")." };
    return getComposition({ pieceId: params.pieceId });
  }
  return getCompositionTimeline(params);
}

/** The compact timeline text for the targeted pieces. A piece that does not exist is named, not fatal. */
export async function getCompositionTimeline(params: GetCompositionParams): Promise<ToolResult> {
  const targets = resolvePieceTargets(params);
  if (!targets.ok) return { success: false, error: targets.error };

  const db = getDb();
  const rows = targets.pieceIds.length === 0 ? [] : db.select({ id: pieces.id, name: pieces.name, hasDraft: pieces.hasDraft }).from(pieces).where(inArray(pieces.id, targets.pieceIds)).all();
  const rowById = new Map(rows.map((r) => [r.id, r]));

  const inputs: TimelinePieceInput[] = [];
  const missing: string[] = [];
  for (const id of targets.pieceIds) {
    const row = rowById.get(id);
    if (!row) {
      missing.push(id);
      continue;
    }
    const { manifest } = await loadComposition(id);
    const fileIds = new Set<string>();
    for (const c of manifest.audioClips ?? []) fileIds.add(c.fileId);
    for (const o of manifest.overlays ?? []) {
      const fid = (o as { fileId?: unknown }).fileId;
      if (typeof fid === "string") fileIds.add(fid);
    }
    const fileRows = fileIds.size === 0 ? [] : db.select().from(files).where(inArray(files.id, [...fileIds])).all();
    const fileMap = new Map<string, TimelineFile>();
    for (const f of fileRows) {
      const rights = effectiveRights(f);
      fileMap.set(f.id, { name: f.name || f.filename, duration: f.mediaDuration, rights: rights ? { class: rights.class, track: rights.track?.title } : null });
    }
    inputs.push({ pieceId: id, name: row.name, manifest, hasDraft: row.hasDraft, files: fileMap });
  }
  if (inputs.length === 0) return { success: false, error: `piece_not_found: ${missing.join(", ")}` };

  return {
    success: true,
    data: {
      view: "timeline",
      pieces: inputs.length,
      timeline: renderTimeline(inputs),
      ...(missing.length > 0 ? { notFound: missing } : {}),
      ...(targets.note ? { note: targets.note } : {}),
    },
  };
}
