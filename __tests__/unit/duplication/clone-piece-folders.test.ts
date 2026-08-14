import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { getDb } from "@/lib/db/client";
import { pieces, files, assetFolders } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-dup-folders-"));
  process.env.LIBI_HOME = tmp;
  delete process.env.STORAGE_DIR;
  createTestDb();
});
afterEach(() => {
  resetTestDb();
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("clonePieceInto — asset folder tree", () => {
  it("clones the folder, gives it a fresh id, and remaps the file's folderId", async () => {
    const { clonePieceInto } = await import("@/lib/duplication/clone-piece");
    const { getStorage } = await import("@/lib/storage");
    const db = getDb();
    const storage = await getStorage();

    seedPiece(db as never, { id: "src" });
    const folderId = crypto.randomUUID();
    const fileId = crypto.randomUUID();
    db.insert(assetFolders).values({ id: folderId, pieceId: "src", name: "Extends" }).run();
    db.insert(files).values({
      id: fileId, pieceId: "src", folderId, filename: "a.mp4", name: "a",
      description: "", type: "video", storagePath: "src/a.mp4", size: 4,
    }).run();
    await storage.save("src", "a.mp4", Buffer.from("data"), "video/mp4");

    db.insert(pieces).values({ id: "dst", name: "src (copy)" }).run();

    await clonePieceInto("src", "dst", "draft");

    const dstFolders = db.select().from(assetFolders).where(eq(assetFolders.pieceId, "dst")).all();
    expect(dstFolders).toHaveLength(1);
    expect(dstFolders[0].name).toBe("Extends");
    expect(dstFolders[0].id).not.toBe(folderId);

    const dstFiles = db.select().from(files).where(eq(files.pieceId, "dst")).all();
    expect(dstFiles).toHaveLength(1);
    expect(dstFiles[0].folderId).toBe(dstFolders[0].id);
    expect(dstFiles[0].folderId).not.toBe(folderId);
  });

  it("preserves nested folder parent links with remapped ids (two-pass)", async () => {
    const { clonePieceInto } = await import("@/lib/duplication/clone-piece");
    const { getStorage } = await import("@/lib/storage");
    const db = getDb();
    const storage = await getStorage();

    seedPiece(db as never, { id: "src" });
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const fileId = crypto.randomUUID();
    db.insert(assetFolders).values({ id: parentId, pieceId: "src", name: "Parent" }).run();
    db.insert(assetFolders).values({ id: childId, pieceId: "src", name: "Child", parentFolderId: parentId }).run();
    db.insert(files).values({
      id: fileId, pieceId: "src", folderId: childId, filename: "b.mp4", name: "b",
      description: "", type: "video", storagePath: "src/b.mp4", size: 4,
    }).run();
    await storage.save("src", "b.mp4", Buffer.from("data"), "video/mp4");

    db.insert(pieces).values({ id: "dst", name: "src (copy)" }).run();

    await clonePieceInto("src", "dst", "draft");

    const dstFolders = db.select().from(assetFolders).where(eq(assetFolders.pieceId, "dst")).all();
    expect(dstFolders).toHaveLength(2);
    const dstParent = dstFolders.find((f) => f.name === "Parent")!;
    const dstChild = dstFolders.find((f) => f.name === "Child")!;
    // fresh ids
    expect(dstParent.id).not.toBe(parentId);
    expect(dstChild.id).not.toBe(childId);
    // child's parent points at the CLONED parent, not the source parent
    expect(dstChild.parentFolderId).toBe(dstParent.id);
    expect(dstParent.parentFolderId).toBeNull();
    // file lands in the cloned child folder
    const dstFiles = db.select().from(files).where(eq(files.pieceId, "dst")).all();
    expect(dstFiles[0].folderId).toBe(dstChild.id);
  });
});
