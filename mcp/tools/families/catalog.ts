import { z } from "zod/v3";
import {
  listCharacters,
  getCharacter,
  createCharacter,
  updateCharacter,
  deleteCharacter,
  linkCharacterToAsset,
  unlinkCharacterFromAsset,
} from "@/mcp/tools/character-tools";
import {
  listItems,
  getItem,
  createItem,
  updateItem,
  deleteItem,
  linkItemToAsset,
  unlinkItemFromAsset,
} from "@/mcp/tools/item-tools";
import {
  ListCharactersSchema,
  GetCharacterSchema,
  CreateCharacterSchema,
  UpdateCharacterSchema,
  DeleteCharacterSchema,
  LinkCharacterToAssetSchema,
  UnlinkCharacterFromAssetSchema,
  ListItemsSchema,
  GetItemSchema,
  CreateItemSchema,
  UpdateItemSchema,
  DeleteItemSchema,
  LinkItemToAssetSchema,
  UnlinkItemFromAssetSchema,
} from "@/mcp/tools/schemas";
import { action, type ActionToolDef } from "@/mcp/tools/action-tool";

const ctx = { pieceId: "" };

// `create` takes a non-empty id string, `update` also null (clears it): advertise the wider type, each action still enforces its own.
// `fromAsset` is advertised as an open object (its shape is in the `create` text); `create` still validates it in full.
const widen = { representativeImageFileId: z.string().nullable(), fromAsset: z.record(z.unknown()) };

export const characterTool: ActionToolDef = {
  name: "libi.character",
  description:
    "The global catalog of recurring characters (people, figures, anything with a voice or agency): list/look up by name, catalog one from an asset's crop, update, delete, link/unlink to assets. Actions: list, get, create, update, delete, link, unlink. Products and props are libi.catalog_item.",
  widen,
  props: {
    id: "Character id (from list or create).",
    name: "Character name, unique across all characters.",
    fromAsset: "{ fileId, bbox: { x, y, w, h }, frameTime? } crops the representative image from a source asset (frameTime required for videos).",
    deleteAssets: "If true, also delete every linked asset file. Needs the user's explicit confirmation first.",
    characterId: "Id of the character to link to / unlink from the asset.",
    fileId: "Id of the asset (file) that contains the character.",
    representativeImageFileId: "create: an existing file to use as its image (ignored if `fromAsset` is set). update: a file id to set it, or null to clear it.",
  },
  actions: {
    list: action({
      describe:
        "list characters, optional `query` (name substring). Call it BEFORE creating one; if several match, show the user each `representativeImageUrl` to confirm",
      schema: ListCharactersSchema,
      run: (params) => listCharacters(ctx, params),
    }),
    get: action({
      describe: "one character with its linked asset ids",
      schema: GetCharacterSchema,
      run: (params) => getCharacter(ctx, params),
    }),
    create: action({
      describe:
        "catalog a new character; `fromAsset: { fileId, bbox, frameTime? }` crops its image (frameTime required for videos). Then show the image inline (`![name](representativeImageUrl)`) and ask if the name and crop are right",
      schema: CreateCharacterSchema,
      run: (params) => createCharacter(ctx, params),
    }),
    update: action({
      describe: "change a character's name, description or representative image",
      schema: UpdateCharacterSchema,
      run: (params) => updateCharacter(ctx, params),
    }),
    delete: action({
      describe:
        "remove from the catalog and unlink its assets; the assets stay unless `deleteAssets: true` (confirm with the user first)",
      schema: DeleteCharacterSchema,
      run: (params) => deleteCharacter(ctx, params),
    }),
    link: action({
      describe: "link an asset that contains it; idempotent",
      schema: LinkCharacterToAssetSchema,
      run: (params) => linkCharacterToAsset(ctx, params),
    }),
    unlink: action({
      describe: "remove an asset link",
      schema: UnlinkCharacterFromAssetSchema,
      run: (params) => unlinkCharacterFromAsset(ctx, params),
    }),
  },
};

export const catalogItemTool: ActionToolDef = {
  name: "libi.catalog_item",
  description:
    "The global catalog of recurring items (products, props, set pieces): list/look up by name, catalog one from an asset's crop, update, delete, link/unlink to assets. Actions: list, get, create, update, delete, link, unlink. People and figures are libi.character.",
  widen,
  props: {
    id: "Item id (from list or create).",
    name: "Item name, unique across all items.",
    fromAsset: "{ fileId, bbox: { x, y, w, h }, frameTime? } crops the representative image from a source asset (frameTime required for videos).",
    deleteAssets: "If true, also delete every linked asset file. Needs the user's explicit confirmation first.",
    itemId: "Id of the item to link to / unlink from the asset.",
    fileId: "Id of the asset (file) that contains the item.",
    query: "Case-insensitive substring of the item name.",
    representativeImageFileId: "create: an existing file to use as its image (ignored if `fromAsset` is set). update: a file id to set it, or null to clear it.",
  },
  actions: {
    list: action({
      describe:
        "list items, optional `query` (name substring). Call it BEFORE creating one; if several match, show the user each `representativeImageUrl` to confirm",
      schema: ListItemsSchema,
      run: (params) => listItems(ctx, params),
    }),
    get: action({
      describe: "one item with its linked asset ids",
      schema: GetItemSchema,
      run: (params) => getItem(ctx, params),
    }),
    create: action({
      describe:
        "catalog a new item; `fromAsset: { fileId, bbox, frameTime? }` crops its image (frameTime required for videos). Then show the image inline (`![name](representativeImageUrl)`) and ask if the name and crop are right",
      schema: CreateItemSchema,
      run: (params) => createItem(ctx, params),
    }),
    update: action({
      describe: "change an item's name, description or representative image",
      schema: UpdateItemSchema,
      run: (params) => updateItem(ctx, params),
    }),
    delete: action({
      describe:
        "remove from the catalog and unlink its assets; the assets stay unless `deleteAssets: true` (confirm with the user first)",
      schema: DeleteItemSchema,
      run: (params) => deleteItem(ctx, params),
    }),
    link: action({
      describe: "link an asset that contains it; idempotent",
      schema: LinkItemToAssetSchema,
      run: (params) => linkItemToAsset(ctx, params),
    }),
    unlink: action({
      describe: "remove an asset link",
      schema: UnlinkItemFromAssetSchema,
      run: (params) => unlinkItemFromAsset(ctx, params),
    }),
  },
};
