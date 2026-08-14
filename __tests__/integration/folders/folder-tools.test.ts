import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { getDb } from "@/lib/db/client";
import * as folderTools from "@/mcp/tools/folder-tools";

describe("folder MCP tools", () => {
  beforeEach(() => createTestDb());
  afterEach(() => resetTestDb());

  it("create_folder + list_folders", async () => {
    const created = await folderTools.createFolderTool({ name: "Campaign" });
    expect(created.success).toBe(true);
    const list = await folderTools.listFoldersTool();
    expect(list.success).toBe(true);
    expect((list.data as { folders: unknown[] }).folders).toHaveLength(1);
  });

  it("move_folder rejects a cycle", async () => {
    const a = await folderTools.createFolderTool({ name: "a" });
    const aId = (a.data as { folder: { id: string } }).folder.id;
    const b = await folderTools.createFolderTool({ name: "b", parentFolderId: aId });
    const bId = (b.data as { folder: { id: string } }).folder.id;
    const res = await folderTools.moveFolderTool({ folderId: aId, parentFolderId: bId });
    expect(res.success).toBe(false);
    expect(res.error).toBe("cycle_rejected");
  });

  it("move_piece_to_folder updates the piece", async () => {
    seedPiece(getDb() as never, { id: "p1" });
    const f = await folderTools.createFolderTool({ name: "f" });
    const fId = (f.data as { folder: { id: string } }).folder.id;
    const res = await folderTools.movePieceToFolderTool({ pieceId: "p1", folderId: fId });
    expect(res.success).toBe(true);
  });

  it("delete_folder cascade requires confirm", async () => {
    const f = await folderTools.createFolderTool({ name: "f" });
    const fId = (f.data as { folder: { id: string } }).folder.id;
    const res = await folderTools.deleteFolderTool({ folderId: fId, mode: "cascade" });
    expect(res.success).toBe(false);
    expect(res.error).toBe("confirmation_required");
  });
});
