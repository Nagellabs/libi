import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";

vi.mock("@/lib/navigation-events", () => ({ navigationEmitter: { emit: vi.fn() } }));

import {
  createAssetFolderTool, renameAssetFolderTool, deleteAssetFolderTool,
  moveAssetFolderTool, moveAssetTool, listAssetsTool,
} from "@/mcp/tools/asset-folder-tools";

let db: ReturnType<typeof createTestDb>;
beforeEach(() => { db = createTestDb(); seedPiece(db); });
afterEach(() => resetTestDb());

function seedFile(id: string, folderId: string | null = null) {
  db.insert(files).values({
    id, pieceId: "test-piece-1", folderId, filename: `${id}.mp4`, name: id,
    description: "", type: "video", storagePath: `p/${id}.mp4`, size: 1,
  }).run();
}

describe("asset-folder tools", () => {
  it("creates a folder and lists it at the root level", async () => {
    const created = await createAssetFolderTool({ pieceId: "test-piece-1", name: "Extends" });
    expect(created.success).toBe(true);
    const listed = await listAssetsTool({ pieceId: "test-piece-1" });
    const folders = (listed.data?.folders ?? []) as Array<{ name: string }>;
    expect(listed.success && folders.map((f) => f.name)).toContain("Extends");
  });

  it("rejects creating a folder whose parent is in a different scope", async () => {
    const global = await createAssetFolderTool({ pieceId: null, name: "G" });
    const parentId = (global.data as { folder: { id: string } }).folder.id;
    const res = await createAssetFolderTool({
      pieceId: "test-piece-1",
      name: "Child",
      parentFolderId: parentId,
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("scope_mismatch");
  });

  it("moveAssetTool places an asset in a folder; listAssets reflects it", async () => {
    const f = await createAssetFolderTool({ pieceId: "test-piece-1", name: "A" });
    const folderId = (f.data as { folder: { id: string } }).folder.id;
    seedFile("file1");
    const moved = await moveAssetTool({ fileId: "file1", folderId });
    expect(moved.success).toBe(true);
    const level = await listAssetsTool({ pieceId: "test-piece-1", folderId });
    const assets = (level.data?.assets ?? []) as Array<{ id: string }>;
    expect(level.success && assets.map((a) => a.id)).toEqual(["file1"]);
  });

  it("rename + move folder", async () => {
    const a = (await createAssetFolderTool({ pieceId: "test-piece-1", name: "A" })).data as { folder: { id: string } };
    const b = (await createAssetFolderTool({ pieceId: "test-piece-1", name: "B" })).data as { folder: { id: string } };
    expect((await renameAssetFolderTool({ folderId: a.folder.id, name: "A2" })).success).toBe(true);
    expect((await moveAssetFolderTool({ folderId: b.folder.id, parentFolderId: a.folder.id })).success).toBe(true);
  });

  it("delete cascade without confirm returns an error result", async () => {
    const a = (await createAssetFolderTool({ pieceId: "test-piece-1", name: "A" })).data as { folder: { id: string } };
    const res = await deleteAssetFolderTool({ folderId: a.folder.id, mode: "cascade" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("confirm");
  });
});
