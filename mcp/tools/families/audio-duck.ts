import { notify } from "@/mcp/notify";
import * as tools from "@/mcp/tools";
import { audioDuckEnableSchema, audioDuckDisableSchema, audioDuckUpdateSchema } from "@/mcp/tools/schemas";
import { action, type ActionToolDef } from "@/mcp/tools/action-tool";
import type { AnyToolResult } from "@/mcp/tools/types";

async function refreshing(pieceId: string, run: () => Promise<AnyToolResult>): Promise<AnyToolResult> {
  const result = await run();
  if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId });
  return result;
}

export const audioDuckTool: ActionToolDef = {
  name: "libi.audio_duck",
  description:
    "Sidechain-duck an audio clip so music dips under voiceover/dialogue (auto-duck): enable, tune or remove ducking on a clip. Actions: enable, update, disable.",
  props: {
    sidechainClipIds: "The clips whose volume drives the duck: pass ALL dialogue/VO clips (levels are summed; no need to bounce them into one file). update replaces the whole set.",
    thresholdDb: "Sidechain threshold in dBFS. enable default -30; on update, omit to keep the current value.",
    ratio: "Compression ratio. enable default 4; on update, omit to keep the current value.",
    attackMs: "Attack time in ms. enable default 50; on update, omit to keep the current value.",
    releaseMs: "Release time in ms. enable default 250; on update, omit to keep the current value.",
    reductionDb: "Max gain reduction in dB. enable default -12; on update, omit to keep the current value.",
  },
  actions: {
    enable: action({
      describe:
        "turn ducking on; pass EVERY voice clip in `sidechainClipIds` (summed). Defaults: -30 dBFS, 4:1, 50 ms attack, 250 ms release, -12 dB max",
      schema: audioDuckEnableSchema,
      run: (params) => refreshing(params.pieceId, () => tools.audioDuckEnable({ pieceId: params.pieceId }, params)),
    }),
    update: action({
      describe:
        "patch any subset of the ducking parameters on a clip that already ducks; `sidechainClipIds` replaces the whole set driving the duck",
      schema: audioDuckUpdateSchema,
      run: (params) => refreshing(params.pieceId, () => tools.audioDuckUpdate({ pieceId: params.pieceId }, params)),
    }),
    disable: action({
      describe: "remove ducking from a clip",
      schema: audioDuckDisableSchema,
      run: (params) => refreshing(params.pieceId, () => tools.audioDuckDisable({ pieceId: params.pieceId }, params)),
    }),
  },
};
