import type { ToolResult } from "./types";
import {
  createAssetFolder, renameAssetFolder, getAssetFolder,
  listChildAssetFolders, listAssetsAtLevel, recursiveAssetCounts,
} from "@/lib/asset-folders/repo";
import { deleteAssetFolder, moveAsset, moveAssetFolder } from "@/lib/asset-folders/lifecycle";

export async function listAssetsTool(params: {
  pieceId: string | null;
  folderId?: string;
}): Promise<ToolResult> {
  const scope = params.pieceId;
  const counts = recursiveAssetCounts(scope);
  const folders = listChildAssetFolders(scope, params.folderId ?? null)
    .map((f) => ({ ...f, assetCount: counts.get(f.id) ?? 0 }));
  const assets = listAssetsAtLevel(scope, params.folderId ?? null);
  return { success: true, data: { folders, assets } };
}

export async function createAssetFolderTool(params: {
  pieceId: string | null;
  name: string;
  parentFolderId?: string;
}): Promise<ToolResult> {
  const name = params.name.trim();
  if (!name) return { success: false, error: "invalid_name" };
  if (params.parentFolderId) {
    const parent = getAssetFolder(params.parentFolderId);
    if (!parent) return { success: false, error: "asset_folder_not_found" };
    // The parent must live in the same scope as the new folder, else the
    // child would never surface (listings filter by scope).
    if ((parent.pieceId ?? null) !== (params.pieceId ?? null)) {
      return { success: false, error: "scope_mismatch" };
    }
  }
  const folder = createAssetFolder({
    pieceId: params.pieceId,
    name,
    parentFolderId: params.parentFolderId ?? null,
  });
  return { success: true, data: { folder } };
}

export async function renameAssetFolderTool(params: {
  folderId: string;
  name: string;
}): Promise<ToolResult> {
  if (!getAssetFolder(params.folderId)) return { success: false, error: "asset_folder_not_found" };
  const name = params.name.trim();
  if (!name) return { success: false, error: "invalid_name" };
  return { success: true, data: { folder: renameAssetFolder(params.folderId, name) } };
}

export async function deleteAssetFolderTool(params: {
  folderId: string;
  mode?: "orphan" | "cascade";
  confirm?: boolean;
}): Promise<ToolResult> {
  try {
    const res = await deleteAssetFolder(params.folderId, params.mode ?? "orphan", {
      confirm: params.confirm,
    });
    return {
      success: true,
      data: { deletedFolderId: res.deletedFolderId, removedFileCount: res.removedFileCount },
    };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

export async function moveAssetFolderTool(params: {
  folderId: string;
  parentFolderId: string | null;
}): Promise<ToolResult> {
  try {
    await moveAssetFolder(params.folderId, params.parentFolderId);
    return { success: true, data: { folderId: params.folderId } };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

export async function moveAssetTool(params: {
  fileId: string;
  folderId: string | null;
}): Promise<ToolResult> {
  try {
    await moveAsset(params.fileId, params.folderId);
    return { success: true, data: { fileId: params.fileId, folderId: params.folderId } };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}
