import { z } from "zod/v3";
import { notify } from "@/mcp/notify";
import {
  createFolderTool,
  renameFolderTool,
  moveFolderTool,
  movePieceToFolderTool,
  deleteFolderTool,
  listFoldersTool,
} from "@/mcp/tools/folder-tools";
import { duplicateFolderTool } from "@/mcp/tools/duplication-tools";
import {
  createFolderSchema,
  renameFolderSchema,
  moveFolderSchema,
  movePieceToFolderSchema,
  deleteFolderSchema,
  listFoldersSchema,
  duplicateFolderSchema,
} from "@/mcp/tools/schemas";
import { action, type ActionToolDef } from "@/mcp/tools/action-tool";

// `folderId` is a plain id for most actions, but `move_piece` also takes null (the root); `parentFolderId`
// is optional for `create` and nullable for `move`; `name` is required (non-empty) for `create`/`rename`
// and optional for `duplicate`. Advertise the widest type; each action still enforces its own.
const widen = {
  folderId: z.string().nullable(),
  parentFolderId: z.string().nullable(),
  name: z.string(),
};

export const pieceFolderTool: ActionToolDef = {
  name: "libi.piece_folder",
  description:
    "Organize PIECES into nestable folders (the sidebar's tree): create, rename, move, delete or list folders, move a piece into a folder (or the root), or duplicate a folder with its pieces. Actions: create, rename, move, delete, list, move_piece, duplicate. A piece's asset folders are libi.asset_folder.",
  widen,
  props: {
    folderId: "The folder to act on; move_piece: the destination (null or omitted = the root).",
    parentFolderId: "create/move: the parent; null or omitted = top level. Cycles are refused.",
    name: "create/rename: the display name. duplicate: the copy's name, default '<source> (copy)'.",
  },
  actions: {
    create: action({
      describe: "create a folder to organize pieces; nestable (omit `parentFolderId` for a top-level folder)",
      schema: createFolderSchema,
      run: async (params) => {
        const result = await createFolderTool(params);
        if (result.success) notify.refreshQuery({ queryKey: "folders" });
        return result;
      },
    }),
    rename: action({
      describe: "rename a folder",
      schema: renameFolderSchema,
      run: async (params) => {
        const result = await renameFolderTool(params);
        if (result.success) notify.refreshQuery({ queryKey: "folders" });
        return result;
      },
    }),
    move: action({
      describe: "move a folder under a new parent (`parentFolderId` null = top level); a move that would create a cycle is rejected",
      schema: moveFolderSchema,
      run: async (params) => {
        const result = await moveFolderTool(params);
        if (result.success) notify.refreshQuery({ queryKey: "folders" });
        return result;
      },
    }),
    delete: action({
      describe:
        "delete a folder. mode 'orphan' moves its pieces and sub-folders up to the parent first; mode 'cascade' deletes the folder AND every piece and sub-folder inside it: destructive, requires confirm:true",
      schema: deleteFolderSchema,
      run: async (params) => {
        const result = await deleteFolderTool(params);
        if (result.success) {
          notify.refreshQuery({ queryKey: "folders" });
          notify.refreshQuery({ queryKey: "pieces" });
        }
        return result;
      },
    }),
    list: action({
      describe: "all folders as a flat array with parent and piece counts (build the tree from parentFolderId)",
      schema: listFoldersSchema,
      run: () => listFoldersTool(),
    }),
    move_piece: action({
      describe: "move a piece into the folder `folderId`; null or omitted moves it back to the root (no folder)",
      schema: movePieceToFolderSchema,
      run: async (params) => {
        const result = await movePieceToFolderTool(params);
        if (result.success) {
          notify.refreshQuery({ queryKey: "folders" });
          notify.refreshQuery({ queryKey: "pieces" });
        }
        return result;
      },
    }),
    duplicate: action({
      describe:
        "create an independent copy of a folder and all its pieces. Returns jobIds (one per piece) at once; the copies run in the background: poll libi.job({ action: \"status\", jobId }) until all are 'completed' before editing them. Mention the disk cost to the user first when the pieces hold large media",
      schema: duplicateFolderSchema,
      run: async (params) => {
        const result = await duplicateFolderTool(params);
        if (result.success) {
          notify.refreshQuery({ queryKey: "folders" });
          notify.refreshQuery({ queryKey: "pieces" });
        }
        return result;
      },
    }),
  },
};
