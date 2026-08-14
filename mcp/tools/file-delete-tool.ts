import { deleteFile } from "@/lib/files/delete-file";
import type { ToolContext, ToolResult } from "./types";
import type { DeleteFileParams } from "./schemas";

/**
 * Delete a source file. The only destructive op exposed to agents — keep
 * the description firm so the LLM never reaches for it when the user
 * meant "remove the clip from the timeline."
 */
export async function deleteFileTool(
  _ctx: ToolContext,
  params: DeleteFileParams,
): Promise<ToolResult> {
  const result = await deleteFile(params.fileId);
  if (!result.success) {
    return { success: false, error: result.error ?? "Failed to delete file" };
  }
  return {
    success: true,
    data: {
      fileId: result.fileId,
      filename: result.filename,
      removedClips: result.removedClips,
      removedOverlays: result.removedOverlays,
    },
  };
}
