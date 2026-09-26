import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { getDb } from "@/lib/db/client";
import * as folderTools from "@/mcp/tools/folder-tools";
import { notify } from "@/mcp/notify";

describe("folder MCP tools", () => {
  // A cascade tells the studio each piece is gone over HTTP — never from a test.
  let pieceDeleted: MockInstance<(pieceId: string) => void>;
  beforeEach(() => {
    createTestDb();
    pieceDeleted = vi.spyOn(notify, "pieceDeleted").mockImplementation(() => {});
  });
  afterEach(() => {
    resetTestDb();
    pieceDeleted.mockRestore();
  });

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

  it("delete_folder cascade tells the studio each deleted piece is gone — its render diagnostics live there (Task 11 fix M1)", async () => {
    const f = await folderTools.createFolderTool({ name: "f" });
    const fId = (f.data as { folder: { id: string } }).folder.id;
    seedPiece(getDb() as never, { id: "in1" });
    seedPiece(getDb() as never, { id: "in2" });
    seedPiece(getDb() as never, { id: "outside" });
    await folderTools.movePieceToFolderTool({ pieceId: "in1", folderId: fId });
    await folderTools.movePieceToFolderTool({ pieceId: "in2", folderId: fId });
    const res = await folderTools.deleteFolderTool({ folderId: fId, mode: "cascade", confirm: true });
    expect(res.success).toBe(true);
    expect(pieceDeleted.mock.calls.map((c) => c[0]).sort()).toEqual(["in1", "in2"]);
    expect(res.data).not.toHaveProperty("removedPieceIds"); // the agent's result is unchanged
  });
});
