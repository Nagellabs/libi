import { eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { characters, items, characterAssets, itemAssets, files } from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import type { Character, Item } from "./types";
import type { FileRecord } from "@/lib/db/schema/types";

type Db = BetterSQLite3Database<Record<string, unknown>>;

export class CatalogDerive {
  constructor(private readonly db: Db) {}

  charactersByAssetForPiece(pieceId: string): { file: FileRecord; characters: Character[] }[] {
    const pieceFiles = this.db.select().from(files).where(eq(files.pieceId, pieceId)).all();
    if (pieceFiles.length === 0) return [];
    const fileIds = pieceFiles.map((f) => f.id);
    const links = this.db
      .select()
      .from(characterAssets)
      .where(inArray(characterAssets.fileId, fileIds))
      .all();
    if (links.length === 0) return [];
    const charIds = Array.from(new Set(links.map((l) => l.characterId)));
    const chars = this.db.select().from(characters).where(inArray(characters.id, charIds)).all();
    const charById = new Map(chars.map((c) => [c.id, c]));
    return pieceFiles
      .map((file) => ({
        file,
        characters: links
          .filter((l) => l.fileId === file.id)
          .map((l) => charById.get(l.characterId))
          .filter((c): c is Character => c !== undefined),
      }))
      .filter((g) => g.characters.length > 0);
  }

  itemsByAssetForPiece(pieceId: string): { file: FileRecord; items: Item[] }[] {
    const pieceFiles = this.db.select().from(files).where(eq(files.pieceId, pieceId)).all();
    if (pieceFiles.length === 0) return [];
    const fileIds = pieceFiles.map((f) => f.id);
    const links = this.db.select().from(itemAssets).where(inArray(itemAssets.fileId, fileIds)).all();
    if (links.length === 0) return [];
    const itemIds = Array.from(new Set(links.map((l) => l.itemId)));
    const itemRows = this.db.select().from(items).where(inArray(items.id, itemIds)).all();
    const itemById = new Map(itemRows.map((i) => [i.id, i]));
    return pieceFiles
      .map((file) => ({
        file,
        items: links
          .filter((l) => l.fileId === file.id)
          .map((l) => itemById.get(l.itemId))
          .filter((i): i is Item => i !== undefined),
      }))
      .filter((g) => g.items.length > 0);
  }
}

export function getCatalogDerive(): CatalogDerive {
  return new CatalogDerive(getDb() as unknown as Db);
}
