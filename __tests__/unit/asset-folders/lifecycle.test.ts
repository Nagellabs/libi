import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files, assetFolders } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { createAssetFolder, listAssetsAtLevel } from "@/lib/asset-folders/repo";

vi.mock("@/lib/navigation-events", () => ({
  navigationEmitter: { emit: vi.fn() },
}));

// External side-effects of deleteFile() — mock disk/proxy/cascade/tracking so
// the cascade test runs in isolation. The DB row deletion is NOT mocked; it
// happens for real inside deleteFile via getDb().
vi.mock("@/lib/storage", () => ({
  getStorage: vi.fn(async () => ({ delete: vi.fn(async () => {}) })),
}));
vi.mock("@/lib/proxy/lifecycle", () => ({
  dropProxyFile: vi.fn(),
}));
vi.mock("@/lib/composition/persistence", () => ({
  removeReferencesToFile: vi.fn(async () => ({
    removedScenes: [],
    removedClips: [],
    removedOverlays: [],
  })),
}));
vi.mock("@/lib/tracking/repo", () => ({
  listTracksByFile: vi.fn(async () => []),
  deleteTrackRow: vi.fn(async () => {}),
}));
vi.mock("@/lib/tracking/storage", () => ({
  deleteTrack: vi.fn(async () => {}),
}));

import { deleteAssetFolder, moveAsset, moveAssetFolder } from "@/lib/asset-folders/lifecycle";

let db: ReturnType<typeof createTestDb>;
beforeEach(() => { db = createTestDb(); seedPiece(db); });
afterEach(() => resetTestDb());

function seedFile(id: string, pieceId: string | null, folderId: string | null = null) {
  db.insert(files).values({
    id, pieceId, folderId, filename: `${id}.mp4`, name: id, description: "",
    type: "video", storagePath: `p/${id}.mp4`, size: 1,
  }).run();
}

describe("deleteAssetFolder", () => {
  it("orphan: reparents child folders + files to the deleted folder's parent", async () => {
    const a = createAssetFolder({ pieceId: "test-piece-1", name: "A" });
    const b = createAssetFolder({ pieceId: "test-piece-1", name: "B", parentFolderId: a.id });
    seedFile("f1", "test-piece-1", a.id);
    await deleteAssetFolder(a.id, "orphan");
    expect(db.select().from(assetFolders).where(eq(assetFolders.id, a.id)).all()).toHaveLength(0);
    expect(db.select().from(assetFolders).where(eq(assetFolders.id, b.id)).get()?.parentFolderId).toBeNull();
    expect(db.select().from(files).where(eq(files.id, "f1")).get()?.folderId).toBeNull();
  });

  it("cascade: deletes the folder, its subfolders, and contained files", async () => {
    const a = createAssetFolder({ pieceId: "test-piece-1", name: "A" });
    const b = createAssetFolder({ pieceId: "test-piece-1", name: "B", parentFolderId: a.id });
    seedFile("fa", "test-piece-1", a.id);
    seedFile("fb", "test-piece-1", b.id);
    await deleteAssetFolder(a.id, "cascade", { confirm: true });
    expect(db.select().from(assetFolders).all()).toHaveLength(0);
    expect(db.select().from(files).all()).toHaveLength(0);
  });

  it("cascade without confirm throws", async () => {
    const a = createAssetFolder({ pieceId: "test-piece-1", name: "A" });
    await expect(deleteAssetFolder(a.id, "cascade")).rejects.toThrow("confirm_required");
  });
});

describe("moveAsset", () => {
  it("moves a file into a same-scope folder", async () => {
    const a = createAssetFolder({ pieceId: "test-piece-1", name: "A" });
    seedFile("f1", "test-piece-1", null);
    await moveAsset("f1", a.id);
    expect(listAssetsAtLevel("test-piece-1", a.id).map((f) => f.id)).toEqual(["f1"]);
  });

  it("rejects cross-scope move (piece file → global folder)", async () => {
    const g = createAssetFolder({ pieceId: null, name: "G" });
    seedFile("f1", "test-piece-1", null);
    await expect(moveAsset("f1", g.id)).rejects.toThrow("scope_mismatch");
  });
});

describe("moveAssetFolder", () => {
  it("rejects a cycle", async () => {
    const a = createAssetFolder({ pieceId: "test-piece-1", name: "A" });
    const b = createAssetFolder({ pieceId: "test-piece-1", name: "B", parentFolderId: a.id });
    await expect(moveAssetFolder(a.id, b.id)).rejects.toThrow("cycle");
  });
});
