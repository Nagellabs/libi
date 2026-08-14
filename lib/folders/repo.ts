import { eq, isNull, asc, desc } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { folders, pieces } from "@/lib/db/schema/sqlite";
import type { FolderRecord, Piece } from "@/lib/db/schema/types";

export interface CreateFolderInput {
  name: string;
  parentFolderId?: string | null;
}

/** Insert a folder row and return it. */
export function createFolder(input: CreateFolderInput): FolderRecord {
  const db = getDb();
  const [row] = db
    .insert(folders)
    .values({
      name: input.name,
      parentFolderId: input.parentFolderId ?? null,
    })
    .returning()
    .all();
  return row;
}

/** Fetch one folder by id, or null. */
export function getFolder(id: string): FolderRecord | null {
  const db = getDb();
  const [row] = db.select().from(folders).where(eq(folders.id, id)).all();
  return row ?? null;
}

/** All folders, name-ascending. */
export function listAllFolders(): FolderRecord[] {
  const db = getDb();
  return db.select().from(folders).orderBy(asc(folders.name)).all();
}

/** Direct child folders of `parentId` (null = top level), name-ascending. */
export function listChildFolders(parentId: string | null): FolderRecord[] {
  const db = getDb();
  return db
    .select()
    .from(folders)
    .where(parentId === null ? isNull(folders.parentFolderId) : eq(folders.parentFolderId, parentId))
    .orderBy(asc(folders.name))
    .all();
}

/** Rename a folder; bumps updatedAt. */
export function renameFolder(id: string, name: string): FolderRecord {
  const db = getDb();
  const [row] = db
    .update(folders)
    .set({ name, updatedAt: new Date() })
    .where(eq(folders.id, id))
    .returning()
    .all();
  return row;
}

/** Re-parent a folder (null = root); bumps updatedAt. Caller must cycle-check first. */
export function setFolderParent(id: string, parentId: string | null): FolderRecord {
  const db = getDb();
  const [row] = db
    .update(folders)
    .set({ parentFolderId: parentId, updatedAt: new Date() })
    .where(eq(folders.id, id))
    .returning()
    .all();
  return row;
}

/** Delete a single folder row. Callers handle children separately. */
export function deleteFolderRow(id: string): void {
  const db = getDb();
  db.delete(folders).where(eq(folders.id, id)).run();
}

/** Move a piece into a folder (null = root); bumps updatedAt. */
export function setPieceFolder(pieceId: string, folderId: string | null): void {
  const db = getDb();
  db.update(pieces)
    .set({ folderId, updatedAt: new Date() })
    .where(eq(pieces.id, pieceId))
    .run();
}

/** Pieces directly inside a folder (null = root), updatedAt-descending. */
export function listPiecesInFolder(folderId: string | null): Piece[] {
  const db = getDb();
  return db
    .select()
    .from(pieces)
    .where(folderId === null ? isNull(pieces.folderId) : eq(pieces.folderId, folderId))
    .orderBy(desc(pieces.updatedAt))
    .all();
}

/** Map of folderId -> count of pieces directly inside it. */
export function pieceCountsByFolder(): Map<string, number> {
  const db = getDb();
  const rows = db.select({ folderId: pieces.folderId }).from(pieces).all();
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.folderId) counts.set(r.folderId, (counts.get(r.folderId) ?? 0) + 1);
  }
  return counts;
}
