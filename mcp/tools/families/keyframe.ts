import { notify } from "@/mcp/notify";
import * as tools from "@/mcp/tools";
import { deleteKeyframeSchema, setKeyframeEasingSchema, listKeyframesSchema } from "@/mcp/tools/schemas";
import { action, type ActionToolDef } from "@/mcp/tools/action-tool";

export const keyframeTool: ActionToolDef = {
  name: "libi.keyframe",
  description:
    "Inspect and edit keyframes (the timeline diamonds) of an overlay (`overlayId`) or an audio clip's volume envelope (`clipId`): list, delete, set easing (ease-in, ease-out, ease-in-out, bounce, cubic-bezier). Actions: list, delete, set_easing. To ADD a keyframe or animate position/scale/rotation/opacity (slide, fade, zoom, spin) or a volume dip use libi.add_keyframe.",
  props: {
    time: "Keyframe time in SECONDS within the overlay or clip window (delete: the one to remove; set_easing: the one whose OUTGOING segment gets the curve).",
  },
  actions: {
    list: action({
      describe:
        "an overlay's keyframes: { overlayId, duration, times (SECONDS), tracks: { rect?, opacity?, transform3d? } }, each track an array of { time, easing? }; an audio clip's: { clipId, duration, gainDb?, times, tracks: { volumeDb } } of { time, db, easing? }",
      schema: listKeyframesSchema,
      run: (params) => tools.listKeyframes(params),
    }),
    delete: action({
      describe:
        "remove the keyframe at `time` on every track (a track left with under 2 keyframes becomes constant)",
      schema: deleteKeyframeSchema,
      run: async (params) => {
        const result = await tools.deleteKeyframe(params);
        if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        return result;
      },
    }),
    set_easing: action({
      describe:
        "set the easing of the segment LEAVING the keyframe at `time`: a preset id (linear, ease-in, ease-out, ease-in-out, bounce-out, …) or cubic-bezier(a,b,c,d)",
      schema: setKeyframeEasingSchema,
      run: async (params) => {
        const result = await tools.setKeyframeEasing(params);
        if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        return result;
      },
    }),
  },
};
