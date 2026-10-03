import { z } from "zod/v3";
import { notify } from "@/mcp/notify";
import {
  createAssetFolderTool,
  renameAssetFolderTool,
  deleteAssetFolderTool,
  moveAssetFolderTool,
  moveAssetTool,
  assetFolderPieceId,
  filePieceId,
} from "@/mcp/tools/asset-folder-tools";
import {
  createAssetFolderSchema,
  renameAssetFolderSchema,
  deleteAssetFolderSchema,
  moveAssetFolderSchema,
  moveAssetSchema,
} from "@/mcp/tools/schemas";
import { action, type ActionToolDef } from "@/mcp/tools/action-tool";

// `folderId` is a plain id for the folder actions but nullable for `move_asset` (null = scope root);
// `parentFolderId` is optional for `create` and nullable for `move`. Advertise the widest type; each
// action still enforces its own.
const widen = { folderId: z.string().nullable(), parentFolderId: z.string().nullable() };

export const assetFolderTool: ActionToolDef = {
  name: "libi.asset_folder",
  description:
    "Group a piece's (or the global pool's) assets into folders: create, rename, move or delete an asset folder, move an asset into one. One asset is one file; group related assets (extend chain, variants, takes) in a folder created once, then upload each file with folderId. A lone asset stays at the root; there is no default or active file. Actions: create, rename, move, delete, move_asset. Piece folders are libi.piece_folder.",
  widen,
  props: {
    folderId:
      "rename/move/delete: the asset folder to act on. move_asset: the target folder; null = the scope root (the folder must match the file's scope).",
    parentFolderId: "create: the parent folder; omit for a top-level folder. move: the new parent; null = top level. Cycle-checked.",
  },
  actions: {
    create: action({
      describe:
        "create a nestable asset folder within a piece (`pieceId`) or globally (`pieceId` null); create it once, then upload each file with `folderId`",
      schema: createAssetFolderSchema,
      run: async (params) => {
        const result = await createAssetFolderTool(params);
        if (result.success) {
          notify.refreshQuery({ queryKey: "asset-folders", pieceId: params.pieceId ?? undefined });
        }
        return result;
      },
    }),
    rename: action({
      describe: "rename an asset folder",
      schema: renameAssetFolderSchema,
      run: async (params) => {
        const pieceId = assetFolderPieceId(params.folderId);
        const result = await renameAssetFolderTool(params);
        if (result.success) notify.refreshQuery({ queryKey: "asset-folders", pieceId });
        return result;
      },
    }),
    move: action({
      describe: "move an asset folder under a new parent (`parentFolderId` null = top level); cycles are rejected",
      schema: moveAssetFolderSchema,
      run: async (params) => {
        const pieceId = assetFolderPieceId(params.folderId);
        const result = await moveAssetFolderTool(params);
        if (result.success) notify.refreshQuery({ queryKey: "asset-folders", pieceId });
        return result;
      },
    }),
    delete: action({
      describe:
        "delete an asset folder. mode 'orphan' (default, safe) moves its contents to the parent first. Use mode 'cascade' only on the user's explicit intent (\"delete that folder and everything in it\"): it deletes the folder AND every asset and subfolder inside and requires confirm:true",
      schema: deleteAssetFolderSchema,
      run: async (params) => {
        const pieceId = assetFolderPieceId(params.folderId);
        const result = await deleteAssetFolderTool(params);
        if (result.success) {
          // Orphaned files change folder and cascaded ones are gone: the files list is stale too.
          notify.refreshQuery({ queryKey: "asset-folders", pieceId });
          notify.refreshQuery({ queryKey: "files", pieceId });
        }
        return result;
      },
    }),
    move_asset: action({
      describe: "move an asset into a folder (`folderId` null = scope root); the folder must match the file's scope",
      schema: moveAssetSchema,
      run: async (params) => {
        const pieceId = filePieceId(params.fileId);
        const result = await moveAssetTool(params);
        if (result.success) {
          notify.refreshQuery({ queryKey: "asset-folders", pieceId });
          notify.refreshQuery({ queryKey: "files", pieceId });
        }
        return result;
      },
    }),
  },
};
