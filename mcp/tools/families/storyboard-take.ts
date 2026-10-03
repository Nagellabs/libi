import { notify } from "@/mcp/notify";
import {
  approveStoryboardStage,
  attachStoryboardKeyframe,
  attachStoryboardClip,
  selectStoryboardTake,
  hideStoryboardTake,
} from "@/mcp/tools/storyboard-tools";
import {
  approveStoryboardStageSchema,
  attachStoryboardKeyframeSchema,
  attachStoryboardClipSchema,
  selectStoryboardTakeSchema,
  hideStoryboardTakeSchema,
} from "@/mcp/tools/schemas";
import { action, type ActionToolDef } from "@/mcp/tools/action-tool";
import type { AnyToolResult } from "@/mcp/tools/types";

function refreshStoryboard(pieceId: string, result: AnyToolResult): AnyToolResult {
  if (result.success) notify.refreshQuery({ queryKey: "storyboard", pieceId });
  return result;
}

export const storyboardTakeTool: ActionToolDef = {
  name: "libi.storyboard_take",
  description:
    "Record a storyboard card's generated media and advance it: attach a keyframe image or clip video (a libi file id) as a versioned take, choose which take sits on the timeline, hide a take, approve a tier. Actions: attach_clip, attach_keyframe, select, hide, approve_stage. The generation spec is libi.set_storyboard_generation; cards are libi.add_storyboard_card / edit_storyboard_card.",
  props: {
    cardId: "Id of the storyboard card.",
  },
  actions: {
    attach_clip: action({
      describe:
        "attach a generated Tier-3 clip (libi file id) as a new versioned take (v1, v2, …), recording its cost. Generate and upload it FIRST. `select` chooses the take on the timeline; advancing the stage is `approve_stage`",
      schema: attachStoryboardClipSchema,
      run: async (params) => refreshStoryboard(params.pieceId, await attachStoryboardClip(params, { pieceId: params.pieceId })),
    }),
    attach_keyframe: action({
      describe:
        "attach a generated Tier-2 keyframe image (libi file id), recording its cost and advancing the card to the keyframe stage. Generate it (the provider reference names the model; condition it on the card's schematic + character ref) and upload it FIRST",
      schema: attachStoryboardKeyframeSchema,
      run: async (params) => refreshStoryboard(params.pieceId, await attachStoryboardKeyframe(params, { pieceId: params.pieceId })),
    }),
    select: action({
      describe: "choose the take placed on the timeline (re-places the scene)",
      schema: selectStoryboardTakeSchema,
      run: async (params) => refreshStoryboard(params.pieceId, await selectStoryboardTake(params, { pieceId: params.pieceId })),
    }),
    hide: action({
      describe: "soft-hide a take (file kept); if it was selected, the newest remaining one is reselected",
      schema: hideStoryboardTakeSchema,
      run: async (params) => refreshStoryboard(params.pieceId, await hideStoryboardTake(params, { pieceId: params.pieceId })),
    }),
    approve_stage: action({
      describe:
        "approve the card's tier (`stage`: schematic | keyframe | clip). keyframe/clip are PAID and gated on the previous tier; structural edits are done in the card files",
      schema: approveStoryboardStageSchema,
      run: async (params) => {
        const result = await approveStoryboardStage(params, { pieceId: params.pieceId });
        if (result.success) {
          notify.refreshQuery({ queryKey: "storyboard", pieceId: params.pieceId });
          // Approving the clip stage places/updates a video OVERLAY in the composition: invalidate the
          // composition so the timeline/preview reflects it (saveManifest only emits piece-state/pieces).
          if (params.stage === "clip") {
            notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
          }
        }
        return result;
      },
    }),
  },
};
