import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { navigationEmitter } from "@/lib/navigation-events";
import { deleteFile } from "@/lib/files/delete-file";
import { getDescendantIds, wouldCreateCycle, type TreeNode } from "@/lib/folders/tree";
import {
  getAssetFolder, listAssetFoldersForScope, listChildAssetFolders,
  listAssetsAtLevel, setAssetFolderParent, setFileFolder, deleteAssetFolderRow,
} from "./repo";

export type DeleteAssetFolderMode = "orphan" | "cascade";

export interface DeleteAssetFolderResult {
  deletedFolderId: string;
  mode: DeleteAssetFolderMode;
  removedFileCount: number;
}

/**
 * Delete an asset folder.
 *
 * - `"orphan"` (default): reparents the folder's child folders and contained
 *   files to the deleted folder's parent, then removes the folder row. No file
 *   bytes are touched.
 * - `"cascade"`: permanently deletes the folder, all its descendant folders,
 *   and every file at or below it (via `deleteFile`, the single destructive
 *   flow). Requires `opts.confirm === true`; throws `confirm_required` otherwise.
 */
export async function deleteAssetFolder(
  folderId: string,
  mode: DeleteAssetFolderMode = "orphan",
  opts: { confirm?: boolean } = {},
): Promise<DeleteAssetFolderResult> {
  const folder = getAssetFolder(folderId);
  if (!folder) throw new Error("asset_folder_not_found");
  const scope = folder.pieceId;
  let removedFileCount = 0;

  if (mode === "orphan") {
    const parentId = folder.parentFolderId;
    for (const child of listChildAssetFolders(scope, folderId)) {
      setAssetFolderParent(child.id, parentId);
    }
    for (const file of listAssetsAtLevel(scope, folderId)) {
      setFileFolder(file.id, parentId);
    }
    deleteAssetFolderRow(folderId);
  } else {
    if (!opts.confirm) throw new Error("confirm_required");
    const all = listAssetFoldersForScope(scope);
    const tree: TreeNode[] = all.map((f) => ({ id: f.id, parentFolderId: f.parentFolderId }));
    const idsDeepestFirst = [...getDescendantIds(folderId, tree), folderId]
      .sort((a, b) => depth(b, tree) - depth(a, tree));
    for (const id of idsDeepestFirst) {
      for (const file of listAssetsAtLevel(scope, id)) {
        await deleteFile(file.id);
        removedFileCount++;
      }
      deleteAssetFolderRow(id);
    }
  }

  emitRefresh(scope);
  return { deletedFolderId: folderId, mode, removedFileCount };
}

/** Move a file into a folder (or to scope root with `null`). Same-scope only. */
export async function moveAsset(fileId: string, folderId: string | null): Promise<void> {
  const db = getDb();
  const file = db.select().from(files).where(eq(files.id, fileId)).get();
  if (!file) throw new Error("file_not_found");
  if (folderId !== null) {
    const target = getAssetFolder(folderId);
    if (!target) throw new Error("asset_folder_not_found");
    if ((file.pieceId ?? null) !== (target.pieceId ?? null)) throw new Error("scope_mismatch");
  }
  setFileFolder(fileId, folderId);
  emitRefresh(file.pieceId ?? null);
}

/** Reparent a folder (or move to scope root with `null`). Same-scope, no cycles. */
export async function moveAssetFolder(folderId: string, parentFolderId: string | null): Promise<void> {
  const folder = getAssetFolder(folderId);
  if (!folder) throw new Error("asset_folder_not_found");
  if (parentFolderId !== null) {
    const parent = getAssetFolder(parentFolderId);
    if (!parent) throw new Error("asset_folder_not_found");
    if ((parent.pieceId ?? null) !== (folder.pieceId ?? null)) throw new Error("scope_mismatch");
  }
  const all = listAssetFoldersForScope(folder.pieceId);
  const tree: TreeNode[] = all.map((f) => ({ id: f.id, parentFolderId: f.parentFolderId }));
  if (wouldCreateCycle(folderId, parentFolderId, tree)) throw new Error("cycle");
  setAssetFolderParent(folderId, parentFolderId);
  emitRefresh(folder.pieceId);
}

function emitRefresh(scope: string | null) {
  navigationEmitter.emit("refresh_query", { queryKey: "asset-folders", pieceId: scope ?? undefined });
  navigationEmitter.emit("refresh_query", { queryKey: "files", pieceId: scope ?? undefined });
}

function depth(id: string, all: TreeNode[]): number {
  const byId = new Map(all.map((f) => [f.id, f]));
  let d = 0; let cur = byId.get(id)?.parentFolderId ?? null;
  const seen = new Set<string>([id]);
  while (cur && !seen.has(cur)) { d++; seen.add(cur); cur = byId.get(cur)?.parentFolderId ?? null; }
  return d;
}
