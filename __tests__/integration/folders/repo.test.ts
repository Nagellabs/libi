import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import {
  createFolder,
  getFolder,
  listAllFolders,
  listChildFolders,
  renameFolder,
  setFolderParent,
  deleteFolderRow,
  setPieceFolder,
  listPiecesInFolder,
} from "@/lib/folders/repo";

describe("folders repo", () => {
  beforeEach(() => createTestDb());
  afterEach(() => resetTestDb());

  it("creates a root folder and reads it back", () => {
    const f = createFolder({ name: "Campaign" });
    expect(f.id).toBeTruthy();
    expect(f.name).toBe("Campaign");
    expect(f.parentFolderId).toBeNull();
    expect(getFolder(f.id)?.name).toBe("Campaign");
  });

  it("creates a nested folder under a parent", () => {
    const root = createFolder({ name: "Campaign" });
    const child = createFolder({ name: "IG cuts", parentFolderId: root.id });
    expect(child.parentFolderId).toBe(root.id);
    expect(listChildFolders(root.id).map((f) => f.id)).toEqual([child.id]);
    expect(listChildFolders(null).map((f) => f.id)).toEqual([root.id]);
  });

  it("renames and re-parents a folder", () => {
    const a = createFolder({ name: "A" });
    const b = createFolder({ name: "B" });
    expect(renameFolder(a.id, "A2").name).toBe("A2");
    expect(setFolderParent(a.id, b.id).parentFolderId).toBe(b.id);
    expect(setFolderParent(a.id, null).parentFolderId).toBeNull();
  });

  it("moves a piece into and out of a folder", () => {
    const f = createFolder({ name: "F" });
    const pieceId = seedPiece(createTestDbRef(), { id: "p1" });
    setPieceFolder("p1", f.id);
    expect(listPiecesInFolder(f.id).map((p) => p.id)).toEqual(["p1"]);
    setPieceFolder("p1", null);
    expect(listPiecesInFolder(f.id)).toEqual([]);
    expect(listPiecesInFolder(null).map((p) => p.id)).toContain("p1");
    void pieceId;
  });

  it("deleteFolderRow removes only the row", () => {
    const f = createFolder({ name: "F" });
    deleteFolderRow(f.id);
    expect(getFolder(f.id)).toBeNull();
    expect(listAllFolders()).toEqual([]);
  });
});

// seedPiece needs the db handle; createTestDb installs the global singleton,
// so re-grab it for seedPiece's typed signature.
import { getDb } from "@/lib/db/client";
function createTestDbRef() {
  return getDb() as unknown as Parameters<typeof seedPiece>[0];
}
