import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { resolveCopyName } from "./copy-name";
import {
  createFolder, getFolder, listAllFolders, listPiecesInFolder,
} from "@/lib/folders/repo";
import { getDescendantIds } from "@/lib/folders/tree";

export interface FolderCloneResult {
  newFolderId: string;
  copies: { newPieceId: string; sourcePieceId: string }[];
}

/**
 * Recreate the folder subtree rooted at `sourceFolderId` (rows only — instant),
 * placing the new root at top level with `newName`. For every piece anywhere
 * in the subtree, create a shell `pieces` row (named `<piece> (copy)`) inside
 * the corresponding cloned folder. Returns the new root id + the list of
 * (newPieceId, sourcePieceId) pairs for the caller to enqueue `piece_dup` jobs.
 * Throws `folder_not_found` if the source folder is missing.
 */
export function cloneFolderSubtree(sourceFolderId: string, newName: string): FolderCloneResult {
  const db = getDb();
  const src = getFolder(sourceFolderId);
  if (!src) throw new Error("folder_not_found");

  const all = listAllFolders();
  const subtreeIds = [sourceFolderId, ...getDescendantIds(sourceFolderId, all)];
  const folderIdMap = new Map<string, string>();

  // Clone the root first, then descendants in breadth order so parents exist.
  const newRoot = createFolder({ name: newName, parentFolderId: null });
  folderIdMap.set(sourceFolderId, newRoot.id);

  // Walk descendants parent-before-child.
  const remaining = new Set(subtreeIds.filter((id) => id !== sourceFolderId));
  while (remaining.size > 0) {
    let progressed = false;
    for (const id of [...remaining]) {
      const folder = all.find((f) => f.id === id)!;
      const mappedParent = folder.parentFolderId ? folderIdMap.get(folder.parentFolderId) : undefined;
      if (!mappedParent) continue; // parent not cloned yet
      const cloned = createFolder({ name: folder.name, parentFolderId: mappedParent });
      folderIdMap.set(id, cloned.id);
      remaining.delete(id);
      progressed = true;
    }
    if (!progressed) break; // safety against corrupt data
  }

  // Shell pieces for every piece in the subtree.
  const copies: { newPieceId: string; sourcePieceId: string }[] = [];
  const existingNames = db.select({ name: pieces.name }).from(pieces).all().map((r) => r.name);
  for (const folderId of subtreeIds) {
    for (const piece of listPiecesInFolder(folderId)) {
      const name = resolveCopyName(piece.name, existingNames);
      existingNames.push(name);
      const [shell] = db
        .insert(pieces)
        .values({ name, folderId: folderIdMap.get(folderId)! })
        .returning()
        .all();
      copies.push({ newPieceId: shell.id, sourcePieceId: piece.id });
    }
  }

  return { newFolderId: newRoot.id, copies };
}
