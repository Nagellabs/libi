import { navigationEmitter } from "@/lib/navigation-events";
import { deletePieceCompletely } from "@/lib/pieces/delete-piece";
import type { DeleteFolderMode } from "./types";
import {
  getFolder,
  listAllFolders,
  listChildFolders,
  listPiecesInFolder,
  setFolderParent,
  setPieceFolder,
  deleteFolderRow,
} from "./repo";
import { getDescendantIds } from "./tree";

export interface DeleteFolderResult {
  deletedFolderId: string;
  mode: DeleteFolderMode;
  removedPieceCount: number;
  /** The pieces a cascade deleted — for a caller in another process than the
   *  studio, which holds per-piece state in memory (render diagnostics). */
  removedPieceIds: string[];
}

/**
 * Delete a folder.
 *  - "orphan": direct child folders + pieces reattach to the folder's parent
 *    (root if it was top-level); only this folder row is removed.
 *  - "cascade": every descendant folder and every piece inside the subtree
 *    is deleted (pieces via deletePieceCompletely).
 * Throws if the folder does not exist.
 */
export async function deleteFolder(
  folderId: string,
  mode: DeleteFolderMode,
): Promise<DeleteFolderResult> {
  const folder = getFolder(folderId);
  if (!folder) throw new Error("folder_not_found");

  const removedPieceIds: string[] = [];

  if (mode === "orphan") {
    const parentId = folder.parentFolderId;
    for (const child of listChildFolders(folderId)) {
      setFolderParent(child.id, parentId);
    }
    for (const piece of listPiecesInFolder(folderId)) {
      setPieceFolder(piece.id, parentId);
    }
    deleteFolderRow(folderId);
  } else {
    const all = listAllFolders();
    // self + every descendant, deepest first so we never delete a parent
    // before its children (keeps behaviour identical with FK enforcement on).
    const descendants = getDescendantIds(folderId, all);
    const idsDeepestFirst = [...descendants, folderId].sort(
      (a, b) => depth(b, all) - depth(a, all),
    );
    for (const id of idsDeepestFirst) {
      for (const piece of listPiecesInFolder(id)) {
        if (await deletePieceCompletely(piece.id)) removedPieceIds.push(piece.id);
      }
      deleteFolderRow(id);
    }
  }

  navigationEmitter.emit("refresh_query", { queryKey: "folders" });
  navigationEmitter.emit("refresh_query", { queryKey: "pieces" });
  return { deletedFolderId: folderId, mode, removedPieceCount: removedPieceIds.length, removedPieceIds };
}

function depth(id: string, all: { id: string; parentFolderId: string | null }[]): number {
  const byId = new Map(all.map((f) => [f.id, f]));
  let d = 0;
  let cur = byId.get(id)?.parentFolderId ?? null;
  const seen = new Set<string>([id]);
  while (cur && !seen.has(cur)) {
    d++;
    seen.add(cur);
    cur = byId.get(cur)?.parentFolderId ?? null;
  }
  return d;
}
