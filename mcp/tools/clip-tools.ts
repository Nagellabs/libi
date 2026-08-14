/** Unified timeline clip operations — cut (split) / delete / duplicate.
 *
 * Thin MCP adapters over the shared `lib/composition/clip-ops` core (the SAME
 * core the timeline right-click menu calls via REST), so the agent and the user
 * get identical behaviour. A "clip" is any timeline entity — scene, overlay, or
 * audio clip — auto-detected from its id. */

import {
  splitClip,
  deleteClip,
  duplicateClip,
  type ClipOpError,
} from "@/lib/composition/clip-ops";
import { overlayLogger as logger } from "@/lib/logger";
import type { ToolResult } from "./types";
import type {
  SplitClipParams,
  DeleteClipParams,
  DuplicateClipParams,
} from "./schemas";

function errorMessage(error: ClipOpError, targetId: string): string {
  switch (error) {
    case "clip_not_found":
      return `No scene, overlay, or audio clip with id ${targetId} on this composition.`;
    case "split_out_of_bounds":
      return `The cut time is not strictly inside ${targetId} (or would leave a sub-frame sliver).`;
  }
}

export async function splitClipTool(params: SplitClipParams): Promise<ToolResult> {
  const result = await splitClip(params.pieceId, params.targetId, params.atTime);
  if (!result.ok) {
    return { success: false, error: errorMessage(result.error, params.targetId) };
  }
  logger.info(
    { tag: "clip-ops", event: "split", pieceId: params.pieceId, family: result.family, headId: result.headId, tailId: result.tailId },
    "split clip",
  );
  return {
    success: true,
    data: { family: result.family, headId: result.headId, tailId: result.tailId },
  };
}

export async function deleteClipTool(params: DeleteClipParams): Promise<ToolResult> {
  const result = await deleteClip(params.pieceId, params.targetId, { ripple: params.ripple });
  if (!result.ok) {
    return { success: false, error: errorMessage(result.error, params.targetId) };
  }
  logger.info(
    { tag: "clip-ops", event: "delete", pieceId: params.pieceId, family: result.family, targetId: result.targetId, removedClips: result.removedClips, ripple: params.ripple },
    "delete clip",
  );
  return {
    success: true,
    data: { family: result.family, targetId: result.targetId, removedClips: result.removedClips },
  };
}

export async function duplicateClipTool(params: DuplicateClipParams): Promise<ToolResult> {
  const result = await duplicateClip(params.pieceId, params.targetId);
  if (!result.ok) {
    return { success: false, error: errorMessage(result.error, params.targetId) };
  }
  logger.info(
    { tag: "clip-ops", event: "duplicate", pieceId: params.pieceId, family: result.family, newId: result.newId },
    "duplicate clip",
  );
  return {
    success: true,
    data: { family: result.family, newId: result.newId },
  };
}
