import { notify } from "@/mcp/notify";
import * as tools from "@/mcp/tools";
import {
  audioUpdateClipSchema,
  audioRemoveClipSchema,
  audioSplitSchema,
  audioUnlinkSchema,
  audioRelinkOverlaySchema,
} from "@/mcp/tools/schemas";
import { action, type ActionToolDef } from "@/mcp/tools/action-tool";
import type { AnyToolResult } from "@/mcp/tools/types";

async function refreshing(pieceId: string, run: () => Promise<AnyToolResult>): Promise<AnyToolResult> {
  const result = await run();
  if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId });
  return result;
}

export const audioClipTool: ActionToolDef = {
  name: "libi.audio_clip",
  description:
    "Edit an existing audio clip on the timeline: timing/trim/volume/gain/crossfade/mute/label, remove it from the timeline, split, unlink an inline clip from its video overlay, or relink a standalone clip to one. Actions: update, remove, split, unlink, relink_overlay. To ADD an audio clip use libi.audio_add_clip. Level: `gainDb` (+/-dB, boost) and a volume envelope via libi.add_keyframe({ clipId, properties: { volumeDb } }); never bake a bed in ffmpeg.",
  props: {
    clipId:
      "Id of the audio clip (unlink: the INLINE clip; relink_overlay: the standalone clip).",
  },
  actions: {
    update: action({
      describe: "patch startTime, duration, trimStart, volume, gainDb, crossfadeMs, enabled (the speaker toggle: mute without removing), label, timelineOrder",
      schema: audioUpdateClipSchema,
      run: (params) => refreshing(params.pieceId, () => tools.audioUpdateClip({ pieceId: params.pieceId }, params)),
    }),
    remove: action({
      describe:
        "remove the clip FROM THE TIMELINE only: the source file is NOT deleted, it stays in resources and can be re-added. For a linked (inline) clip the video overlay keeps playing silently; `relink_overlay` brings the audio back. Use it for 'remove audio from timeline' or 'mute the music section'; permanently deleting the file is the resources panel's",
      schema: audioRemoveClipSchema,
      run: (params) => refreshing(params.pieceId, () => tools.audioRemoveClip({ pieceId: params.pieceId }, params)),
    }),
    split: action({
      describe: "split at `time` (composition seconds, strictly inside the clip); the new clip's id is `data.tailId`",
      schema: audioSplitSchema,
      run: (params) => refreshing(params.pieceId, () => tools.audioSplit({ pieceId: params.pieceId }, params)),
    }),
    unlink: action({
      describe:
        "turn an inline clip (linked to a video overlay) into a standalone one, movable and trimmable independently",
      schema: audioUnlinkSchema,
      run: (params) => refreshing(params.pieceId, () => tools.audioUnlink({ pieceId: params.pieceId }, params)),
    }),
    relink_overlay: action({
      describe: "re-bind a standalone clip to a VIDEO OVERLAY (`overlayId`) as its inline audio, so it moves and trims with it",
      schema: audioRelinkOverlaySchema,
      run: (params) => refreshing(params.pieceId, () => tools.audioRelinkOverlay({ pieceId: params.pieceId }, params)),
    }),
  },
};
