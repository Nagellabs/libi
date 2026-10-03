import { notify } from "@/mcp/notify";
import * as tools from "@/mcp/tools";
import { createCaptionStyleSchema, listCaptionStylesSchema, deleteCaptionStyleSchema } from "@/mcp/tools/schemas";
import { action, type ActionToolDef } from "@/mcp/tools/action-tool";

export const captionStyleTool: ActionToolDef = {
  name: "libi.caption_style",
  description:
    "Create, list or delete reusable caption styles (a static look: text color, stroke/outline, shadow/glow, background plate, font) that show in the Style tab of any caption. Actions: create, list, delete.",
  actions: {
    create: action({
      describe:
        "save a NEW style from explicit fields, no overlay needed. A taken name returns `style_name_exists` (pass override:true to replace); a bundled look's name returns `style_name_reserved`",
      schema: createCaptionStyleSchema,
      run: async (params) => {
        const result = await tools.createCaptionStyle(params);
        if (result.success) notify.refreshQuery({ queryKey: "caption-styles" });
        return result;
      },
    }),
    list: action({
      describe: "list bundled + user styles; do it before creating to avoid duplicate names",
      schema: listCaptionStylesSchema,
      run: async () => tools.listCaptionStylesTool(),
    }),
    delete: action({
      describe: "delete a user style by id; bundled styles cannot be deleted (`style_name_reserved`)",
      schema: deleteCaptionStyleSchema,
      run: async (params) => {
        const result = await tools.deleteCaptionStyle(params);
        if (result.success) notify.refreshQuery({ queryKey: "caption-styles" });
        return result;
      },
    }),
  },
};
