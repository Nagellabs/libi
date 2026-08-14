import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";
import {
  createAssetFolder, getAssetFolder, renameAssetFolder, setAssetFolderParent,
  listAssetFoldersForScope, listChildAssetFolders, setFileFolder,
  listAssetsAtLevel, recursiveAssetCounts,
} from "@/lib/asset-folders/repo";

let db: ReturnType<typeof createTestDb>;
beforeEach(() => { db = createTestDb(); seedPiece(db); });
afterEach(() => resetTestDb());

function seedFile(id: string, opts: { pieceId: string | null; folderId?: string | null }) {
  db.insert(files).values({
    id, pieceId: opts.pieceId, folderId: opts.folderId ?? null,
    filename: `${id}.mp4`, name: id, description: "", type: "video",
    storagePath: `p/${id}.mp4`, size: 1,
  }).run();
}

describe("asset-folders repo", () => {
  it("creates a piece-scoped folder and reads it back", () => {
    const f = createAssetFolder({ pieceId: "test-piece-1", name: "Extends" });
    expect(f.pieceId).toBe("test-piece-1");
    expect(getAssetFolder(f.id)?.name).toBe("Extends");
  });

  it("creates a global folder (pieceId null)", () => {
    const f = createAssetFolder({ pieceId: null, name: "Global Group" });
    expect(f.pieceId).toBeNull();
    expect(listAssetFoldersForScope(null).map((x) => x.id)).toContain(f.id);
  });

  it("scopes folder listing by piece", () => {
    seedPiece(db, { id: "p2" });
    createAssetFolder({ pieceId: "test-piece-1", name: "A" });
    createAssetFolder({ pieceId: "p2", name: "B" });
    expect(listAssetFoldersForScope("test-piece-1").map((f) => f.name)).toEqual(["A"]);
  });

  it("renames + re-parents", () => {
    const a = createAssetFolder({ pieceId: "test-piece-1", name: "A" });
    const b = createAssetFolder({ pieceId: "test-piece-1", name: "B" });
    expect(renameAssetFolder(a.id, "A2").name).toBe("A2");
    setAssetFolderParent(b.id, a.id);
    expect(getAssetFolder(b.id)?.parentFolderId).toBe(a.id);
    expect(listChildAssetFolders("test-piece-1", a.id).map((f) => f.id)).toEqual([b.id]);
  });

  it("listAssetsAtLevel returns only files in that folder", () => {
    const a = createAssetFolder({ pieceId: "test-piece-1", name: "A" });
    seedFile("f-root", { pieceId: "test-piece-1", folderId: null });
    seedFile("f-in-a", { pieceId: "test-piece-1", folderId: a.id });
    expect(listAssetsAtLevel("test-piece-1", null).map((f) => f.id)).toEqual(["f-root"]);
    expect(listAssetsAtLevel("test-piece-1", a.id).map((f) => f.id)).toEqual(["f-in-a"]);
  });

  it("setFileFolder moves a file", () => {
    const a = createAssetFolder({ pieceId: "test-piece-1", name: "A" });
    seedFile("f1", { pieceId: "test-piece-1", folderId: null });
    setFileFolder("f1", a.id);
    expect(listAssetsAtLevel("test-piece-1", a.id).map((f) => f.id)).toEqual(["f1"]);
  });

  it("recursiveAssetCounts rolls up nested folders", () => {
    const a = createAssetFolder({ pieceId: "test-piece-1", name: "A" });
    const b = createAssetFolder({ pieceId: "test-piece-1", name: "B" });
    setAssetFolderParent(b.id, a.id); // B is child of A
    seedFile("fa", { pieceId: "test-piece-1", folderId: a.id });
    seedFile("fb", { pieceId: "test-piece-1", folderId: b.id });
    const counts = recursiveAssetCounts("test-piece-1");
    expect(counts.get(a.id)).toBe(2); // fa + (fb under B under A)
    expect(counts.get(b.id)).toBe(1);
  });
});
