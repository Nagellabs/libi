import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { createFolder, setPieceFolder, listChildFolders, listPiecesInFolder } from "@/lib/folders/repo";
import { cloneFolderSubtree } from "@/lib/duplication/clone-folder";

describe("cloneFolderSubtree", () => {
  beforeEach(() => createTestDb());
  afterEach(() => resetTestDb());

  it("recreates the folder subtree and shell pieces", () => {
    const root = createFolder({ name: "Campaign" });
    const sub = createFolder({ name: "IG", parentFolderId: root.id });
    seedPiece(getDb() as never, { id: "p1" });
    seedPiece(getDb() as never, { id: "p2" });
    setPieceFolder("p1", root.id);
    setPieceFolder("p2", sub.id);

    const res = cloneFolderSubtree(root.id, "Campaign (copy)");

    expect(res.copies).toHaveLength(2);
    // new root folder
    const newRoot = listChildFolders(null).find((f) => f.name === "Campaign (copy)");
    expect(newRoot).toBeTruthy();
    expect(res.newFolderId).toBe(newRoot!.id);
    // new sub-folder under the new root, named like the original sub
    const newSub = listChildFolders(newRoot!.id).find((f) => f.name === "IG");
    expect(newSub).toBeTruthy();
    // shell pieces created, placed in the cloned folders
    for (const c of res.copies) {
      const shell = getDb().select().from(pieces).where(eq(pieces.id, c.newPieceId)).get();
      expect(shell).toBeTruthy();
    }
    expect(listPiecesInFolder(newRoot!.id)).toHaveLength(1);
    expect(listPiecesInFolder(newSub!.id)).toHaveLength(1);
  });

  it("clones an empty folder with no copies", () => {
    const f = createFolder({ name: "Empty" });
    const res = cloneFolderSubtree(f.id, "Empty (copy)");
    expect(res.copies).toEqual([]);
  });
});
