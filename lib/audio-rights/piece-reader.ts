/** Server-side: a piece's audio summary from its draft manifest and files. */
import { inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { loadManifest, type CompositionManifest } from "@/lib/composition/persistence";
import { manifestAsExported } from "@/lib/overlays/hidden";
import { pieceAudioOf, type PieceAudio, type PieceFileLike } from "./piece-audio";
import { effectiveRights } from "./read";
import type { AudioRights } from "./types";

export function filesForManifest(manifest: Pick<CompositionManifest, "audioClips">): PieceFileLike[] {
  const ids = [...new Set((manifest.audioClips ?? []).map((c) => c.fileId))];
  if (ids.length === 0) return [];
  return getDb()
    .select({ id: files.id, name: files.name, type: files.type, hasAudio: files.hasAudio, audioRights: files.audioRights, createdAt: files.createdAt, aiGeneration: files.aiGeneration, description: files.description })
    .from(files)
    .where(inArray(files.id, ids))
    .all();
}

/** The piece's audio AS EXPORTED (hidden layers and their sound left out) —
 *  the export dialog's question must match the export route's 422. */
export async function readPieceAudio(pieceId: string, manifest?: CompositionManifest): Promise<PieceAudio> {
  const m = manifestAsExported(manifest ?? (await loadManifest(pieceId)));
  return pieceAudioOf(m, filesForManifest(m));
}

export type RightsListEntry = { fileId: string; name: string; class: AudioRights["class"]; track?: AudioRights["track"]; source?: AudioRights["source"] };

export async function pieceRightsList(pieceId: string): Promise<RightsListEntry[]> {
  const m = await loadManifest(pieceId);
  return filesForManifest(m).flatMap((f) => {
    const r = effectiveRights(f);
    return r ? [{ fileId: f.id, name: f.name, class: r.class, ...(r.track ? { track: r.track } : {}), ...(r.source ? { source: r.source } : {}) }] : [];
  });
}
