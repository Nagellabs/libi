/** Character catalog MCP tools.
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
  ListCharactersParams,
  GetCharacterParams,
  CreateCharacterParams,
  UpdateCharacterParams,
  DeleteCharacterParams,
  LinkCharacterToAssetParams,
  UnlinkCharacterFromAssetParams,
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

export async function listCharacters(
  _ctx: ToolContext,
  params: ListCharactersParams,
): Promise<CatalogToolResult> {
  return ok({
    characters: repo().listCharacters(params).map(withRepUrl),
  });
}

export async function getCharacter(
  _ctx: ToolContext,
  params: GetCharacterParams,
): Promise<CatalogToolResult> {
  const r = repo();
  const c = r.getCharacter(params.id);
  if (!c) return err("Character not found");
  const linked = r.getCharacterAssets(c.id).map((l) => l.fileId);
  return ok({ character: { ...withRepUrl(c), linkedAssetIds: linked } });
}

export async function createCharacter(
  _ctx: ToolContext,
  params: CreateCharacterParams,
): Promise<CatalogToolResult> {
  const r = repo();
  const existing = r
    .listCharacters({ query: params.name })
    .find((c) => c.name === params.name);
  if (existing) {
    return err(
      `Character "${params.name}" already exists (id ${existing.id}). Use update_character or link_character_to_asset instead.`,
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
        "catalog.create_character_crop_failed",
      );
      return err(
        `Failed to crop representative image: ${(e as Error).message}`,
      );
    }
  }

  const created = r.createCharacter({
    name: params.name,
    description: params.description ?? "",
    representativeImageFileId: repFileId,
    nameSetByUser: params.nameSetByUser ?? false,
  });
  if (autoLinkSourceFileId) {
    r.linkCharacterToAsset(created.id, autoLinkSourceFileId);
  }

  navigationEmitter.emit("refresh_query", { queryKey: "characters" });
  return ok({
    character: {
      ...withRepUrl(created),
      linkedAssetIds: r.getCharacterAssets(created.id).map((l) => l.fileId),
    },
  });
}

export async function updateCharacter(
  _ctx: ToolContext,
  params: UpdateCharacterParams,
): Promise<CatalogToolResult> {
  const r = repo();
  if (!r.getCharacter(params.id)) return err("Character not found");
  if (params.name) {
    const conflict = r
      .listCharacters({ query: params.name })
      .find((c) => c.name === params.name && c.id !== params.id);
    if (conflict) {
      return err(`Another character named "${params.name}" already exists`);
    }
  }
  const updated = r.updateCharacter(params.id, params);
  navigationEmitter.emit("refresh_query", { queryKey: "characters" });
  return ok({ character: withRepUrl(updated) });
}

export async function deleteCharacter(
  _ctx: ToolContext,
  params: DeleteCharacterParams,
): Promise<CatalogToolResult> {
  const r = repo();
  const c = r.getCharacter(params.id);
  if (!c) return err("Character not found");
  const linkedFileIds = r.getCharacterAssets(c.id).map((l) => l.fileId);
  r.deleteCharacter(c.id);
  if (params.deleteAssets) {
    for (const fileId of linkedFileIds) {
      getDb().delete(filesTable).where(eq(filesTable.id, fileId)).run();
    }
  }
  navigationEmitter.emit("refresh_query", { queryKey: "characters" });
  return ok({
    removed: c.name,
    deletedAssetCount: params.deleteAssets ? linkedFileIds.length : 0,
  });
}

export async function linkCharacterToAsset(
  _ctx: ToolContext,
  params: LinkCharacterToAssetParams,
): Promise<CatalogToolResult> {
  const r = repo();
  if (!r.getCharacter(params.characterId)) return err("Character not found");
  const file = getDb()
    .select()
    .from(filesTable)
    .where(eq(filesTable.id, params.fileId))
    .get();
  if (!file) return err("File not found");
  r.linkCharacterToAsset(params.characterId, params.fileId);
  navigationEmitter.emit("refresh_query", { queryKey: "characters" });
  return ok({ characterId: params.characterId, fileId: params.fileId });
}

export async function unlinkCharacterFromAsset(
  _ctx: ToolContext,
  params: UnlinkCharacterFromAssetParams,
): Promise<CatalogToolResult> {
  const r = repo();
  r.unlinkCharacterFromAsset(params.characterId, params.fileId);
  navigationEmitter.emit("refresh_query", { queryKey: "characters" });
  return ok({ characterId: params.characterId, fileId: params.fileId });
}

