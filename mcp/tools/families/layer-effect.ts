import * as tools from "@/mcp/tools";
import { applyLayerEffectSchema, clearLayerEffectSchema } from "@/mcp/tools/schemas";
import { action, type ActionToolDef } from "@/mcp/tools/action-tool";

// Both handlers send their own `composition` refresh (mcp/tools/effect-tools.ts), so the actions add none.
export const layerEffectTool: ActionToolDef = {
  name: "libi.layer_effect",
  description:
    "Put an animation effect on a layer (an overlay or an audio clip) or take it off: fade/pop/slide in, out or loop. Discover effect ids with libi.effect (action list). Actions: apply, clear.",
  props: {
    layerId: "Overlay id or audio clip id.",
    phase: "The effect slot: in, out or loop.",
  },
  actions: {
    apply: action({
      describe:
        "put `effectId` on the layer's `phase` slot. An unknown effectId or an unsupported phase/kind returns a structured error with the valid set",
      schema: applyLayerEffectSchema,
      run: (params) => tools.applyLayerEffect(params),
    }),
    clear: action({
      describe: "remove the effect on the layer's `phase` slot",
      schema: clearLayerEffectSchema,
      run: (params) => tools.clearLayerEffect(params),
    }),
  },
};
