import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import {
  createFolder,
  getFolder,
  setPieceFolder,
  listPiecesInFolder,
} from "@/lib/folders/repo";
import { deleteFolder } from "@/lib/folders/lifecycle";

describe("deleteFolder", () => {
  beforeEach(() => createTestDb());
  afterEach(() => resetTestDb());

  it("orphan mode reattaches direct children to the parent", async () => {
    const root = createFolder({ name: "root" });
    const mid = createFolder({ name: "mid", parentFolderId: root.id });
    const leaf = createFolder({ name: "leaf", parentFolderId: mid.id });
    seedPiece(getDb() as never, { id: "p1" });
    setPieceFolder("p1", mid.id);

    const res = await deleteFolder(mid.id, "orphan");
    expect(res.mode).toBe("orphan");
    expect(getFolder(mid.id)).toBeNull();
    // leaf folder + p1 reattach to root (mid's parent)
    expect(getFolder(leaf.id)?.parentFolderId).toBe(root.id);
    expect(getDb().select().from(pieces).where(eq(pieces.id, "p1")).get()?.folderId).toBe(root.id);
  });

  it("orphan mode on a root folder moves children to root", async () => {
    const root = createFolder({ name: "root" });
    seedPiece(getDb() as never, { id: "p1" });
    setPieceFolder("p1", root.id);
    await deleteFolder(root.id, "orphan");
    expect(getDb().select().from(pieces).where(eq(pieces.id, "p1")).get()?.folderId).toBeNull();
  });

  it("cascade mode deletes every descendant folder and piece", async () => {
    const root = createFolder({ name: "root" });
    const child = createFolder({ name: "child", parentFolderId: root.id });
    seedPiece(getDb() as never, { id: "p1" });
    seedPiece(getDb() as never, { id: "p2" });
    setPieceFolder("p1", root.id);
    setPieceFolder("p2", child.id);

    const res = await deleteFolder(root.id, "cascade");
    expect(res.removedPieceCount).toBe(2);
    expect(getFolder(root.id)).toBeNull();
    expect(getFolder(child.id)).toBeNull();
    expect(getDb().select().from(pieces).all()).toEqual([]);
  });
});
