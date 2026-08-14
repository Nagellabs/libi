import type { ToolResult } from "./types";
import { enqueueJobOnServer } from "@/mcp/jobs-client";
import { createDuplicatePieceShell } from "@/lib/duplication/start";
import { cloneFolderSubtree } from "@/lib/duplication/clone-folder";
import { getFolder, listAllFolders } from "@/lib/folders/repo";
import { resolveCopyName } from "@/lib/duplication/copy-name";

export async function duplicatePieceTool(params: {
  pieceId: string;
  name?: string;
  source?: "draft" | "snapshot";
  folderId?: string | null;
}): Promise<ToolResult> {
  let shell: { newPieceId: string; name: string };
  try {
    shell = createDuplicatePieceShell(params.pieceId, {
      name: params.name,
      folderId: params.folderId === undefined ? undefined : (params.folderId ?? null),
    });
  } catch (err) {
    if (err instanceof Error && err.message === "piece_not_found") {
      return { success: false, error: "piece_not_found" };
    }
    throw err;
  }
  const enq = await enqueueJobOnServer(
    "piece_dup",
    { sourcePieceId: params.pieceId, newPieceId: shell.newPieceId, source: params.source ?? "draft" },
    { pieceId: shell.newPieceId },
  );
  const jobId = enq.status !== "matching_completed" ? enq.jobId : enq.existingJob.jobId;
  return {
    success: true,
    data: { pieceId: shell.newPieceId, name: shell.name, jobId },
  };
}

export async function duplicateFolderTool(params: {
  folderId: string;
  name?: string;
  source?: "draft" | "snapshot";
}): Promise<ToolResult> {
  const src = getFolder(params.folderId);
  if (!src) return { success: false, error: "folder_not_found" };
  const name =
    params.name?.trim() || resolveCopyName(src.name, listAllFolders().map((f) => f.name));
  const { newFolderId, copies } = cloneFolderSubtree(params.folderId, name);
  const jobIds: string[] = [];
  for (const c of copies) {
    const enq = await enqueueJobOnServer(
      "piece_dup",
      { sourcePieceId: c.sourcePieceId, newPieceId: c.newPieceId, source: params.source ?? "draft" },
      { pieceId: c.newPieceId },
    );
    const jobId = enq.status !== "matching_completed" ? enq.jobId : enq.existingJob.jobId;
    jobIds.push(jobId);
  }
  return { success: true, data: { folderId: newFolderId, name, jobIds, pieceCount: copies.length } };
}
