/** Item catalog MCP tools.
 *
 * Returns the MCP wire format directly:
 * `{ content: [{ type: "text", text: <json> }], error?: string }` —
 * same pattern as `mcp/tools/skill-tools.ts`. The `mcp/server.ts`
 * registrations forward the result verbatim.
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files as filesTable } from "@/lib/db/schema";
import { CatalogRepo } from "@/lib/catalog/repo";
import { cropAndStoreRepresentative } from "@/lib/catalog/crop";
import { serverLogger as logger } from "@/lib/logger";
import { navigationEmitter } from "@/lib/navigation-events";
import type { ToolContext } from "./types";
import type {
  ListItemsParams,
  GetItemParams,
  CreateItemParams,
  UpdateItemParams,
  DeleteItemParams,
  LinkItemToAssetParams,
  UnlinkItemFromAssetParams,
} from "./schemas";

export type CatalogToolResult = {
  content: { type: "text"; text: string }[];
  error?: string;
};

function ok(payload: unknown): CatalogToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function err(message: string): CatalogToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    error: message,
  };
}

function repo(): CatalogRepo {
  return new CatalogRepo(getDb() as never);
}

function withRepUrl<T extends { representativeImageFileId: string | null }>(
  c: T,
): T & { representativeImageUrl: string | null } {
  return {
    ...c,
    representativeImageUrl: c.representativeImageFileId
      ? `/api/files/by-id/${c.representativeImageFileId}/content`
      : null,
  };
}

export async function listItems(
  _ctx: ToolContext,
  params: ListItemsParams,
): Promise<CatalogToolResult> {
  return ok({
    items: repo().listItems(params).map(withRepUrl),
  });
}

export async function getItem(
  _ctx: ToolContext,
  params: GetItemParams,
): Promise<CatalogToolResult> {
  const r = repo();
  const c = r.getItem(params.id);
  if (!c) return err("Item not found");
  const linked = r.getItemAssets(c.id).map((l) => l.fileId);
  return ok({ item: { ...withRepUrl(c), linkedAssetIds: linked } });
}

export async function createItem(
  _ctx: ToolContext,
  params: CreateItemParams,
): Promise<CatalogToolResult> {
  const r = repo();
  const existing = r
    .listItems({ query: params.name })
    .find((c) => c.name === params.name);
  if (existing) {
    return err(
      `Item "${params.name}" already exists (id ${existing.id}). Use update_item or link_item_to_asset instead.`,
    );
  }

  let repFileId: string | null = params.representativeImageFileId ?? null;
  let autoLinkSourceFileId: string | null = null;

  if (params.fromAsset) {
    const sourceFile = getDb()
      .select()
      .from(filesTable)
      .where(eq(filesTable.id, params.fromAsset.fileId))
      .get();
    if (!sourceFile) {
      return err(`Source file ${params.fromAsset.fileId} not found`);
    }
    if (
      sourceFile.contentType?.startsWith("video/") &&
      params.fromAsset.frameTime === undefined
    ) {
      return err("frameTime is required when fromAsset references a video");
    }
    try {
      const stored = await cropAndStoreRepresentative({
        sourceFile,
        bbox: params.fromAsset.bbox,
        frameTime: params.fromAsset.frameTime,
        cropName: params.name,
      });
      repFileId = stored.id;
      autoLinkSourceFileId = sourceFile.id;
    } catch (e) {
      logger.error(
        { err: e, name: params.name },
        "catalog.create_item_crop_failed",
      );
      return err(
        `Failed to crop representative image: ${(e as Error).message}`,
      );
    }
  }

  const created = r.createItem({
    name: params.name,
    description: params.description ?? "",
    representativeImageFileId: repFileId,
    nameSetByUser: params.nameSetByUser ?? false,
  });
  if (autoLinkSourceFileId) {
    r.linkItemToAsset(created.id, autoLinkSourceFileId);
  }

  navigationEmitter.emit("refresh_query", { queryKey: "items" });
  return ok({
    item: {
      ...withRepUrl(created),
      linkedAssetIds: r.getItemAssets(created.id).map((l) => l.fileId),
    },
  });
}

export async function updateItem(
  _ctx: ToolContext,
  params: UpdateItemParams,
): Promise<CatalogToolResult> {
  const r = repo();
  if (!r.getItem(params.id)) return err("Item not found");
  if (params.name) {
    const conflict = r
      .listItems({ query: params.name })
      .find((c) => c.name === params.name && c.id !== params.id);
    if (conflict) {
      return err(`Another item named "${params.name}" already exists`);
    }
  }
  const updated = r.updateItem(params.id, params);
  navigationEmitter.emit("refresh_query", { queryKey: "items" });
  return ok({ item: withRepUrl(updated) });
}

export async function deleteItem(
  _ctx: ToolContext,
  params: DeleteItemParams,
): Promise<CatalogToolResult> {
  const r = repo();
  const c = r.getItem(params.id);
  if (!c) return err("Item not found");
  const linkedFileIds = r.getItemAssets(c.id).map((l) => l.fileId);
  r.deleteItem(c.id);
  if (params.deleteAssets) {
    for (const fileId of linkedFileIds) {
      getDb().delete(filesTable).where(eq(filesTable.id, fileId)).run();
    }
  }
  navigationEmitter.emit("refresh_query", { queryKey: "items" });
  return ok({
    removed: c.name,
    deletedAssetCount: params.deleteAssets ? linkedFileIds.length : 0,
  });
}

export async function linkItemToAsset(
  _ctx: ToolContext,
  params: LinkItemToAssetParams,
): Promise<CatalogToolResult> {
  const r = repo();
  if (!r.getItem(params.itemId)) return err("Item not found");
  const file = getDb()
    .select()
    .from(filesTable)
    .where(eq(filesTable.id, params.fileId))
    .get();
  if (!file) return err("File not found");
  r.linkItemToAsset(params.itemId, params.fileId);
  navigationEmitter.emit("refresh_query", { queryKey: "items" });
  return ok({ itemId: params.itemId, fileId: params.fileId });
}

export async function unlinkItemFromAsset(
  _ctx: ToolContext,
  params: UnlinkItemFromAssetParams,
): Promise<CatalogToolResult> {
  const r = repo();
  r.unlinkItemFromAsset(params.itemId, params.fileId);
  navigationEmitter.emit("refresh_query", { queryKey: "items" });
  return ok({ itemId: params.itemId, fileId: params.fileId });
}

