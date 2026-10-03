import { notify } from "@/mcp/notify";
import * as tools from "@/mcp/tools";
import {
  saveOverlayPresetSchema,
  applyOverlayPresetSchema,
  listOverlayPresetsSchema,
  deleteOverlayPresetSchema,
} from "@/mcp/tools/schemas";
import { action, type ActionToolDef } from "@/mcp/tools/action-tool";

export const overlayPresetTool: ActionToolDef = {
  name: "libi.overlay_preset",
  description:
    "Reusable overlay LOOKS (style, animation, transform, effects saved under a name): save an overlay's current look as a preset, apply a preset to another overlay, list presets (bundled + yours), delete one of yours. Actions: save, apply, list, delete.",
  actions: {
    save: action({
      describe:
        "save an overlay's current look as a named preset. A taken user name returns `preset_name_exists` (existing `presetId` in `data`; `override:true` replaces it); a bundled look's name is `preset_name_reserved`: pick another",
      schema: saveOverlayPresetSchema,
      run: (params) => tools.saveOverlayPreset(params),
    }),
    apply: action({
      describe: "apply a saved preset's look onto an overlay of the same kind",
      schema: applyOverlayPresetSchema,
      run: async (params) => {
        const result = await tools.applyOverlayPreset(params);
        if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        return result;
      },
    }),
    list: action({
      describe: "list saved overlay presets (bundled + user), optionally filtered by `kind`",
      schema: listOverlayPresetsSchema,
      run: (params) => tools.listOverlayPresets(params),
    }),
    delete: action({
      describe: "delete a user-saved overlay preset (bundled ones are a no-op)",
      schema: deleteOverlayPresetSchema,
      run: (params) => tools.deleteOverlayPreset(params),
    }),
  },
};
