import { z } from "zod/v3";
import { notify } from "@/mcp/notify";
import * as tools from "@/mcp/tools";
import { showExport } from "@/mcp/tools/export-list-tool";
import { showExtension } from "@/mcp/tools/extension-tools";
import { showFolderTool } from "@/mcp/tools/folder-tools";
import { showSocialSettings } from "@/mcp/tools/social-tools";
import {
  showPieceSchema,
  showPreviewSchema,
  showAssetSchema,
  showStoryboardSchema,
  showExportSchema,
  showFolderSchema,
  showTemplatesSchema,
  showExtensionSchema,
  showSocialSettingsSchema,
} from "@/mcp/tools/schemas";
import { action, type ActionToolDef } from "@/mcp/tools/action-tool";

export const showTool: ActionToolDef = {
  name: "libi.show",
  description:
    "Show something to the user in the studio (`target`: piece, preview, asset, export, storyboard, folder, templates, extension, social_settings). On `*_not_found` or `navigated: false` the screen did NOT change: do not say it did. For an inline image/video in the chat use libi.show_in_chat.",
  props: {
    pieceId: "The piece.",
    fileId: "The asset to display.",
    exportId: "The export to open (from libi.list_exports / export_video).",
    folderId: "The folder to reveal.",
    templateId: "Template to scroll to; omit for the whole page.",
    extensionId: "Extension id to focus, e.g. 'libi-tracking'.",
    accountId: "Social account to point at (libi.social_status id).",
  },
  actions: {
    piece: action({
      describe: "the piece in the editor (right after creating one); `piece_not_found` if deleted",
      schema: showPieceSchema,
      run: async (params) => {
        const result = await tools.showPiece(params);
        // Only after the piece is proven to exist — see navigation-tools.ts.
        if (result.success) notify.navigate({ target: "piece", pieceId: params.pieceId });
        return result;
      },
    }),
    preview: action({
      describe:
        "the Preview tab (player + timeline) when the timeline is the focus; not after every edit, nor for a user on Assets",
      schema: showPreviewSchema,
      run: async (params) => {
        const result = await tools.showPreview(params);
        if (result.success) notify.navigate({ target: "preview", pieceId: params.pieceId });
        return result;
      },
    }),
    asset: action({
      describe:
        "one asset in the Assets tab; `file_not_found` / `file_not_in_piece` (data.ownerPieceId names the owner)",
      schema: showAssetSchema,
      run: async (params) => {
        const result = await tools.showAsset(params);
        // Only after piece AND file are proven — see navigation-tools.ts.
        if (result.success) notify.navigate({ target: "asset", pieceId: params.pieceId, fileId: params.fileId });
        return result;
      },
    }),
    export: action({
      describe: "the Exports tab on ONE export (id from libi.list_exports / export_video); `export_not_found` if gone or cancelled",
      schema: showExportSchema,
      run: (params) => showExport(params),
    }),
    storyboard: action({
      describe: "the Storyboard tab; call it after you create or change the board",
      schema: showStoryboardSchema,
      run: async (params) => {
        const result = await tools.showStoryboard(params);
        if (result.success) notify.navigate({ target: "storyboard", pieceId: params.pieceId });
        return result;
      },
    }),
    folder: action({
      describe: "reveal a PIECE/resources folder in the resources panel; not for asset folders",
      schema: z.object(showFolderSchema),
      run: async (params) => {
        const result = await showFolderTool(params);
        if (result.success) notify.navigate({ target: "folder", id: params.folderId });
        return result;
      },
    }),
    templates: action({
      describe: "the Templates page, optionally at one template; it has no chat, so ask any question first and make this the LAST call of the turn",
      schema: showTemplatesSchema,
      run: (params) => tools.showTemplates(params),
    }),
    extension: action({
      describe: "Agents → Libi MCP at one extension card (e.g. 'libi-tracking'), after telling the user it needs attention",
      schema: showExtensionSchema,
      run: (params) => showExtension(params),
    }),
    social_settings: action({
      describe: "Social → Settings (at `accountId`): what a social result's `needsOpen` / `open` names",
      schema: showSocialSettingsSchema,
      run: (params) => showSocialSettings(params),
    }),
  },
};
