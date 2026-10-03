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
  insertTime,
  type ClipOpError,
} from "@/lib/composition/clip-ops";
import type { StretchOption } from "@/lib/composition/ripple-insert";
import { overlayLogger as logger } from "@/lib/logger";
import type { ToolResult } from "./types";
import type {
  SplitClipParams,
  DeleteClipParams,
  DuplicateClipParams,
  InsertTimeParams,
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

/** `stretch` arrives as a list of ids; the words "spanning" and "none" in a list of their own are the modes. */
function stretchOption(list: string[] | undefined): StretchOption | undefined | "mixed" {
  if (!list) return undefined;
  const modes = list.filter((s) => s === "spanning" || s === "none");
  if (modes.length === 0) return list;
  return list.length === 1 ? (modes[0] as "spanning" | "none") : "mixed";
}

export async function insertTimeTool(params: InsertTimeParams): Promise<ToolResult> {
  const stretch = stretchOption(params.stretch);
  if (stretch === "mixed") {
    return {
      success: false,
      error: 'stretch: "spanning" and "none" are modes of their own: pass [\"spanning\"] or [\"none\"] alone, or a list of ids.',
    };
  }
  const result = await insertTime(params.pieceId, {
    at: params.at,
    seconds: params.seconds,
    stretch,
    extendTarget: params.extendTarget,
  });
  if (!result.ok) return { success: false, error: result.message, data: { code: result.error } };
  const r = result.report;
  logger.info(
    {
      tag: "clip-ops",
      event: "insert_time",
      pieceId: params.pieceId,
      at: r.at,
      seconds: r.seconds,
      shifted: r.shifted.length,
      stretched: r.stretched.length,
      extended: r.extended.length,
    },
    "insert time",
  );
  const nothing = r.shifted.length + r.stretched.length + r.extended.length === 0;
  const note = [
    nothing ? `Nothing starts at or after ${r.at} s and nothing was stretched or extended, so the piece is unchanged.` : "",
    r.leftSpanning.length
      ? `${r.leftSpanning.length} layer(s) start before ${r.at} s and run past it (leftSpanning) and were left as they are: pass \`stretch\` with their ids to lengthen them, or \`extendTarget\` for the one clip that should run longer.`
      : "",
  ].filter(Boolean).join(" ");
  return {
    success: true,
    data: {
      at: r.at,
      seconds: r.seconds,
      pieceDuration: r.pieceDuration,
      shifted: r.shifted,
      stretched: r.stretched,
      extended: r.extended,
      ...(r.leftSpanning.length ? { leftSpanning: r.leftSpanning } : {}),
      ...(r.warnings.length ? { warnings: r.warnings } : {}),
      ...(note ? { note } : {}),
    },
  };
}
