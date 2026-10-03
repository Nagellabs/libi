import { notify } from "@/mcp/notify";
import * as tools from "@/mcp/tools";
import { splitClipSchema, deleteClipSchema, duplicateClipSchema, insertTimeSchema } from "@/mcp/tools/schemas";
import { action, type ActionToolDef } from "@/mcp/tools/action-tool";
import type { AnyToolResult } from "@/mcp/tools/types";

async function refreshing(pieceId: string, run: () => Promise<AnyToolResult>): Promise<AnyToolResult> {
  const result = await run();
  if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId });
  return result;
}

export const clipTool: ActionToolDef = {
  name: "libi.clip",
  description:
    "Edit a timeline clip (an overlay or an audio clip, auto-detected from `targetId`): cut/split it in two at a time, delete/remove it (optionally ripple the gap closed), duplicate/copy it, or insert time (ripple insert: make a gap, a longer intro). Actions: delete, split, duplicate, insert_time.",
  props: {
    targetId: "Id of the timeline clip: an overlay or an audio clip (the family is auto-detected).",
  },
  actions: {
    delete: action({
      describe:
        "remove the clip from the timeline ONLY (the source file is never deleted; a video overlay's inline audio goes with it). The gap stays open by default; `ripple: true` closes it",
      schema: deleteClipSchema,
      run: (params) => refreshing(params.pieceId, () => tools.deleteClipTool(params)),
    }),
    split: action({
      describe:
        "cut in two at `atTime` (composition seconds, strictly inside the clip); the tail's id is `data.tailId`",
      schema: splitClipSchema,
      run: (params) => refreshing(params.pieceId, () => tools.splitClipTool(params)),
    }),
    duplicate: action({
      describe: "copy it, placed right after the original; the new id is `data.newId`",
      schema: duplicateClipSchema,
      run: (params) => refreshing(params.pieceId, () => tools.duplicateClipTool(params)),
    }),
    insert_time: action({
      describe:
        "ripple INSERT (inverse of delete with `ripple`): open `seconds` at `at`; later layers move right, full-length ones stretch, `extendTarget` lengthens one overlay. No `targetId`",
      schema: insertTimeSchema,
      run: (params) => refreshing(params.pieceId, () => tools.insertTimeTool(params)),
    }),
  },
};
