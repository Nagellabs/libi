import type { ToolResult } from "./types";
import {
  createFolder,
  getFolder,
  listAllFolders,
  renameFolder,
  setFolderParent,
  setPieceFolder,
  pieceCountsByFolder,
} from "@/lib/folders/repo";
import { wouldCreateCycle } from "@/lib/folders/tree";
import { deleteFolder } from "@/lib/folders/lifecycle";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

export async function createFolderTool(params: {
  name: string;
  parentFolderId?: string;
}): Promise<ToolResult> {
  const name = params.name.trim();
  if (!name) return { success: false, error: "invalid_name" };
  if (params.parentFolderId && !getFolder(params.parentFolderId)) {
    return { success: false, error: "folder_not_found" };
  }
  const folder = createFolder({ name, parentFolderId: params.parentFolderId ?? null });
  return { success: true, data: { folder } };
}

export async function renameFolderTool(params: {
  folderId: string;
  name: string;
}): Promise<ToolResult> {
  if (!getFolder(params.folderId)) return { success: false, error: "folder_not_found" };
  const name = params.name.trim();
  if (!name) return { success: false, error: "invalid_name" };
  return { success: true, data: { folder: renameFolder(params.folderId, name) } };
}

export async function moveFolderTool(params: {
  folderId: string;
  parentFolderId?: string | null;
}): Promise<ToolResult> {
  if (!getFolder(params.folderId)) return { success: false, error: "folder_not_found" };
  const parentId = params.parentFolderId ?? null;
  if (parentId && !getFolder(parentId)) {
    return { success: false, error: "folder_not_found" };
  }
  if (wouldCreateCycle(params.folderId, parentId, listAllFolders())) {
    return { success: false, error: "cycle_rejected" };
  }
  return { success: true, data: { folder: setFolderParent(params.folderId, parentId) } };
}

export async function movePieceToFolderTool(params: {
  pieceId: string;
  folderId?: string | null;
}): Promise<ToolResult> {
  const db = getDb();
  const piece = db.select().from(pieces).where(eq(pieces.id, params.pieceId)).get();
  if (!piece) return { success: false, error: "piece_not_found" };
  const folderId = params.folderId ?? null;
  if (folderId && !getFolder(folderId)) {
    return { success: false, error: "folder_not_found" };
  }
  setPieceFolder(params.pieceId, folderId);
  return { success: true, data: { pieceId: params.pieceId, folderId } };
}

export async function deleteFolderTool(params: {
  folderId: string;
  mode: "orphan" | "cascade";
  confirm?: boolean;
}): Promise<ToolResult> {
  if (!getFolder(params.folderId)) return { success: false, error: "folder_not_found" };
  if (params.mode === "cascade" && params.confirm !== true) {
    return { success: false, error: "confirmation_required" };
  }
  const result = await deleteFolder(params.folderId, params.mode);
  return { success: true, data: { ...result } };
}

export async function listFoldersTool(): Promise<ToolResult> {
  const counts = pieceCountsByFolder();
  const folders = listAllFolders().map((f) => ({
    id: f.id,
    name: f.name,
    parentFolderId: f.parentFolderId,
    pieceCount: counts.get(f.id) ?? 0,
  }));
  return { success: true, data: { folders } };
}

export async function showFolderTool(params: { folderId: string }): Promise<ToolResult> {
  if (!getFolder(params.folderId)) return { success: false, error: "folder_not_found" };
  return { success: true, data: { folderId: params.folderId } };
}
