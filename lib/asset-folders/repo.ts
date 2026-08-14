import { eq, and, isNull, asc, desc } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { getDb } from "@/lib/db/client";
import { assetFolders, files } from "@/lib/db/schema/sqlite";
import type { AssetFolderRecord, FileRecord } from "@/lib/db/schema/types";
import { getDescendantIds, type TreeNode } from "@/lib/folders/tree";
import type { AssetScope } from "./types";

function scopeEq(col: SQLiteColumn, scope: AssetScope) {
  return scope === null ? isNull(col) : eq(col, scope);
}

export function createAssetFolder(input: {
  pieceId: AssetScope; name: string; parentFolderId?: string | null;
}): AssetFolderRecord {
  const db = getDb();
  const [row] = db.insert(assetFolders).values({
    pieceId: input.pieceId, name: input.name,
    parentFolderId: input.parentFolderId ?? null,
  }).returning().all();
  return row;
}

export function getAssetFolder(id: string): AssetFolderRecord | null {
  const db = getDb();
  const [row] = db.select().from(assetFolders).where(eq(assetFolders.id, id)).all();
  return row ?? null;
}

export function listAssetFoldersForScope(scope: AssetScope): AssetFolderRecord[] {
  const db = getDb();
  return db.select().from(assetFolders)
    .where(scopeEq(assetFolders.pieceId, scope))
    .orderBy(asc(assetFolders.name)).all();
}

export function listChildAssetFolders(scope: AssetScope, parentId: string | null): AssetFolderRecord[] {
  const db = getDb();
  return db.select().from(assetFolders)
    .where(and(
      scopeEq(assetFolders.pieceId, scope),
      parentId === null ? isNull(assetFolders.parentFolderId) : eq(assetFolders.parentFolderId, parentId),
    ))
    .orderBy(asc(assetFolders.name)).all();
}

export function renameAssetFolder(id: string, name: string): AssetFolderRecord {
  const db = getDb();
  const [row] = db.update(assetFolders).set({ name, updatedAt: new Date() })
    .where(eq(assetFolders.id, id)).returning().all();
  return row;
}

/** Caller must cycle-check first. */
export function setAssetFolderParent(id: string, parentId: string | null): AssetFolderRecord {
  const db = getDb();
  const [row] = db.update(assetFolders).set({ parentFolderId: parentId, updatedAt: new Date() })
    .where(eq(assetFolders.id, id)).returning().all();
  return row;
}

export function deleteAssetFolderRow(id: string): void {
  const db = getDb();
  db.delete(assetFolders).where(eq(assetFolders.id, id)).run();
}

export function setFileFolder(fileId: string, folderId: string | null): void {
  const db = getDb();
  db.update(files).set({ folderId }).where(eq(files.id, fileId)).run();
}

/** Files directly inside a folder (null = scope root), newest first. */
export function listAssetsAtLevel(scope: AssetScope, folderId: string | null): FileRecord[] {
  const db = getDb();
  return db.select().from(files)
    .where(and(
      scopeEq(files.pieceId, scope),
      folderId === null ? isNull(files.folderId) : eq(files.folderId, folderId),
    ))
    .orderBy(desc(files.createdAt)).all();
}

/** Map folderId -> recursive count of all files at or below that folder. */
export function recursiveAssetCounts(scope: AssetScope): Map<string, number> {
  const db = getDb();
  const folders = listAssetFoldersForScope(scope);
  const fileRows = db.select({ folderId: files.folderId }).from(files)
    .where(scopeEq(files.pieceId, scope)).all();
  const directByFolder = new Map<string, number>();
  for (const r of fileRows) {
    if (r.folderId) directByFolder.set(r.folderId, (directByFolder.get(r.folderId) ?? 0) + 1);
  }
  const tree: TreeNode[] = folders.map((f) => ({ id: f.id, parentFolderId: f.parentFolderId }));
  const out = new Map<string, number>();
  for (const f of folders) {
    let total = directByFolder.get(f.id) ?? 0;
    for (const d of getDescendantIds(f.id, tree)) total += directByFolder.get(d) ?? 0;
    out.set(f.id, total);
  }
  return out;
}
