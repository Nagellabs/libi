/**
 * Which pieces a multi-piece call means. One reader for `libi.apply_ops` targets and `libi.upload_file`'s
 * `pieceIds` / `pieceFolderId`, so "every piece in this folder" cannot drift between them.
 */
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { folders, pieces } from "@/lib/db/schema/sqlite";
import { getDescendantIds } from "@/lib/folders/tree";

export interface TargetPiece {
  id: string;
  name: string;
}

/** The pieces filed in a folder (and, with `recursive`, in its subfolders), or why there are none. */
export function piecesInFolder(
  folderId: string,
  recursive: boolean | undefined,
): { pieces: TargetPiece[] } | { missing: true } | { empty: true } {
  const db = getDb();
  const [folder] = db.select({ id: folders.id }).from(folders).where(eq(folders.id, folderId)).limit(1).all();
  if (!folder) return { missing: true };
  let ids = [folderId];
  if (recursive) {
    const all = db.select({ id: folders.id, parentFolderId: folders.parentFolderId }).from(folders).all();
    ids = [folderId, ...getDescendantIds(folderId, all)];
  }
  const rows = db.select({ id: pieces.id, name: pieces.name }).from(pieces).where(inArray(pieces.folderId, ids)).all();
  return rows.length === 0 ? { empty: true } : { pieces: rows };
}

/** The named pieces that exist, in the order asked and without repeats, and the ids that are not pieces. */
export function piecesByIds(requested: readonly string[]): { pieces: TargetPiece[]; unknown: string[] } {
  const ids = [...new Set(requested)];
  const rows = ids.length
    ? getDb().select({ id: pieces.id, name: pieces.name }).from(pieces).where(inArray(pieces.id, ids)).all()
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    pieces: ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
    unknown: ids.filter((id) => !byId.has(id)),
  };
}

export interface ManyPieceParams {
  pieceId?: string;
  pieceIds?: string[];
  pieceFolderId?: string;
  recursive?: boolean;
}

export type ManyPieces =
  | { ok: true; pieces: TargetPiece[]; /** true when the call named several pieces (pieceIds or pieceFolderId) */ many: boolean }
  | { ok: false; error: string };

/**
 * The pieces a READ call that takes `pieceId | pieceIds | pieceFolderId` means (`libi.audio_analyze`, `libi.list_files`),
 * named the way `upload_file` names them. A folder's pieces come in name order with natural numbers ("02" before "10"),
 * so the FIRST is the one a person would call piece 1: the reference the others are compared against. `pieceIds` keep
 * the order asked. `pieceId` alone is the single-piece call, unchanged (`many: false`).
 */
export function resolveManyPieces(params: ManyPieceParams, opts: { max: number; fallbackPieceId?: string }): ManyPieces {
  const named = [params.pieceId !== undefined, params.pieceIds !== undefined, params.pieceFolderId !== undefined].filter(Boolean).length;
  if (named > 1) return { ok: false, error: "Mixed targets: name exactly one of pieceId, pieceIds, pieceFolderId." };
  if (params.recursive !== undefined && params.pieceFolderId === undefined) return { ok: false, error: "recursive only goes with pieceFolderId." };

  if (params.pieceFolderId !== undefined) {
    const found = piecesInFolder(params.pieceFolderId, params.recursive);
    if ("missing" in found) return { ok: false, error: `pieceFolderId: no folder ${params.pieceFolderId} (libi.piece_folder action list shows the ids).` };
    if ("empty" in found) {
      return { ok: false, error: `pieceFolderId: folder ${params.pieceFolderId} holds no pieces${params.recursive ? "" : " (pass recursive: true to include its subfolders)"}.` };
    }
    if (found.pieces.length > opts.max) {
      return { ok: false, error: `That folder holds ${found.pieces.length} pieces; at most ${opts.max} per call. Name a subset with pieceIds.` };
    }
    const sorted = found.pieces.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    return { ok: true, pieces: sorted, many: true };
  }

  if (params.pieceIds !== undefined) {
    const found = piecesByIds(params.pieceIds);
    if (found.unknown.length > 0) return { ok: false, error: `pieceIds: no such piece ${found.unknown.join(", ")} (libi.list_pieces shows the ids).` };
    if (found.pieces.length === 0) return { ok: false, error: "pieceIds is empty." };
    if (found.pieces.length > opts.max) return { ok: false, error: `That names ${found.pieces.length} pieces; at most ${opts.max} per call. Split it across calls.` };
    return { ok: true, pieces: found.pieces, many: true };
  }

  const id = params.pieceId ?? opts.fallbackPieceId;
  if (!id) return { ok: false, error: "No target piece: name exactly one of pieceId, pieceIds, pieceFolderId." };
  return { ok: true, pieces: [{ id, name: "" }], many: false };
}
