import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { characters, items, characterAssets, itemAssets } from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import type {
  CatalogListOptions,
  Character,
  CreateCharacterInput,
  CreateItemInput,
  Item,
  UpdateCharacterInput,
  UpdateItemInput,
} from "./types";

type Db = BetterSQLite3Database<Record<string, unknown>>;

export class CatalogRepo {
  constructor(private readonly db: Db) {}

  // ─── characters ────────────────────────────────────────
  listCharacters(opts: CatalogListOptions = {}): Character[] {
    const rows = this.db.select().from(characters).all();
    const filtered = opts.query
      ? rows.filter((r) => r.name.toLowerCase().includes(opts.query!.toLowerCase()))
      : rows;
    const start = opts.offset ?? 0;
    const end = opts.limit ? start + opts.limit : undefined;
    return filtered.slice(start, end);
  }

  getCharacter(id: string): Character | undefined {
    return this.db.select().from(characters).where(eq(characters.id, id)).get();
  }

  createCharacter(input: CreateCharacterInput): Character {
    const id = randomUUID();
    this.db
      .insert(characters)
      .values({
        id,
        name: input.name,
        description: input.description ?? "",
        representativeImageFileId: input.representativeImageFileId ?? null,
        nameSetByUser: input.nameSetByUser ?? false,
      })
      .run();
    return this.getCharacter(id)!;
  }

  updateCharacter(id: string, input: UpdateCharacterInput): Character {
    this.db
      .update(characters)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(characters.id, id))
      .run();
    return this.getCharacter(id)!;
  }

  deleteCharacter(id: string): void {
    this.db.delete(characters).where(eq(characters.id, id)).run();
  }

  linkCharacterToAsset(characterId: string, fileId: string): void {
    this.db
      .insert(characterAssets)
      .values({ characterId, fileId })
      .onConflictDoNothing()
      .run();
  }

  unlinkCharacterFromAsset(characterId: string, fileId: string): void {
    this.db
      .delete(characterAssets)
      .where(and(eq(characterAssets.characterId, characterId), eq(characterAssets.fileId, fileId)))
      .run();
  }

  getCharacterAssets(characterId: string): { fileId: string }[] {
    return this.db
      .select({ fileId: characterAssets.fileId })
      .from(characterAssets)
      .where(eq(characterAssets.characterId, characterId))
      .all();
  }

  // ─── items mirror ──────────────────────────────────────
  listItems(opts: CatalogListOptions = {}): Item[] {
    const rows = this.db.select().from(items).all();
    const filtered = opts.query
      ? rows.filter((r) => r.name.toLowerCase().includes(opts.query!.toLowerCase()))
      : rows;
    const start = opts.offset ?? 0;
    const end = opts.limit ? start + opts.limit : undefined;
    return filtered.slice(start, end);
  }

  getItem(id: string): Item | undefined {
    return this.db.select().from(items).where(eq(items.id, id)).get();
  }

  createItem(input: CreateItemInput): Item {
    const id = randomUUID();
    this.db
      .insert(items)
      .values({
        id,
        name: input.name,
        description: input.description ?? "",
        representativeImageFileId: input.representativeImageFileId ?? null,
        nameSetByUser: input.nameSetByUser ?? false,
      })
      .run();
    return this.getItem(id)!;
  }

  updateItem(id: string, input: UpdateItemInput): Item {
    this.db.update(items).set({ ...input, updatedAt: new Date() }).where(eq(items.id, id)).run();
    return this.getItem(id)!;
  }

  deleteItem(id: string): void {
    this.db.delete(items).where(eq(items.id, id)).run();
  }

  linkItemToAsset(itemId: string, fileId: string): void {
    this.db.insert(itemAssets).values({ itemId, fileId }).onConflictDoNothing().run();
  }

  unlinkItemFromAsset(itemId: string, fileId: string): void {
    this.db
      .delete(itemAssets)
      .where(and(eq(itemAssets.itemId, itemId), eq(itemAssets.fileId, fileId)))
      .run();
  }

  getItemAssets(itemId: string): { fileId: string }[] {
    return this.db
      .select({ fileId: itemAssets.fileId })
      .from(itemAssets)
      .where(eq(itemAssets.itemId, itemId))
      .all();
  }
}

export function getCatalogRepo(): CatalogRepo {
  return new CatalogRepo(getDb() as unknown as Db);
}
