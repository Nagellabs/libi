/**
 * Which pieces a read-many call (`get_composition` timeline, `get_piece_state`) means: exactly one of
 * `pieceId`, `pieceIds` or `folderId`. A folder is its DIRECT pieces, in name order (natural numbers
 * sort as numbers, so "02" and "10" keep their place) — the first one is the reference the others are
 * compared against, so the order has to be the one a person would read.
 */
import { getFolder, listPiecesInFolder } from "@/lib/folders/repo";

/** More than this at once would be an unreadable wall of text; say so instead of truncating silently. */
export const MAX_MULTI_PIECES = 24;

export interface PieceTargetParams {
  pieceId?: string;
  pieceIds?: string[];
  folderId?: string;
}

export type ResolvedTargets =
  | { ok: true; pieceIds: string[]; /** said in the result when the list was cut or came from a folder */ note?: string; folder?: { id: string; name: string } }
  | { ok: false; error: string };

export function resolvePieceTargets(params: PieceTargetParams): ResolvedTargets {
  const given = [params.pieceId ? "pieceId" : "", params.pieceIds ? "pieceIds" : "", params.folderId ? "folderId" : ""].filter(Boolean);
  if (given.length === 0) return { ok: false, error: "Give one of pieceId, pieceIds or folderId." };
  if (given.length > 1) return { ok: false, error: `Give exactly one of pieceId, pieceIds, folderId (got ${given.join(" and ")}).` };

  if (params.pieceId) return { ok: true, pieceIds: [params.pieceId] };

  if (params.pieceIds) {
    const ids = [...new Set(params.pieceIds)];
    if (ids.length === 0) return { ok: false, error: "pieceIds is empty." };
    if (ids.length > MAX_MULTI_PIECES) return { ok: false, error: `pieceIds holds ${ids.length} pieces; at most ${MAX_MULTI_PIECES} per call.` };
    return { ok: true, pieceIds: ids };
  }

  const folder = getFolder(params.folderId!);
  if (!folder) return { ok: false, error: "folder_not_found" };
  const pieces = listPiecesInFolder(folder.id)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  if (pieces.length === 0) return { ok: false, error: `The folder "${folder.name}" holds no pieces (sub-folders are not read).` };
  const cut = pieces.length > MAX_MULTI_PIECES;
  return {
    ok: true,
    pieceIds: pieces.slice(0, MAX_MULTI_PIECES).map((p) => p.id),
    folder: { id: folder.id, name: folder.name },
    note: cut
      ? `The folder holds ${pieces.length} pieces; these are the first ${MAX_MULTI_PIECES} by name. Sub-folders are not read.`
      : "A folder is its direct pieces in name order; the first is the reference. Sub-folders are not read.",
  };
}
