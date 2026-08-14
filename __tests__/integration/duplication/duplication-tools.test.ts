import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
vi.mock("@/mcp/jobs-client", () => ({
  enqueueJobOnServer: vi.fn(async () => ({ status: "new", jobId: "job-x", clientKey: "k" })),
}));
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { createFolder, setPieceFolder } from "@/lib/folders/repo";
import { duplicatePieceTool, duplicateFolderTool } from "@/mcp/tools/duplication-tools";

describe("duplication MCP tools", () => {
  beforeEach(() => createTestDb());
  afterEach(() => resetTestDb());

  it("duplicate_piece creates a shell and returns jobId + name", async () => {
    seedPiece(getDb() as never, { id: "src", name: "Promo" });
    const res = await duplicatePieceTool({ pieceId: "src" });
    expect(res.success).toBe(true);
    const data = res.data as { pieceId: string; name: string; jobId: string };
    expect(data.name).toBe("Promo (copy)");
    expect(data.jobId).toBe("job-x");
    expect(getDb().select().from(pieces).all()).toHaveLength(2);
  });

  it("duplicate_piece returns piece_not_found for a bad id", async () => {
    const res = await duplicatePieceTool({ pieceId: "nope" });
    expect(res.success).toBe(false);
    expect(res.error).toBe("piece_not_found");
  });

  it("duplicate_folder clones a folder and enqueues per piece", async () => {
    const f = createFolder({ name: "Camp" });
    seedPiece(getDb() as never, { id: "p1", name: "P1" });
    setPieceFolder("p1", f.id);
    const res = await duplicateFolderTool({ folderId: f.id });
    expect(res.success).toBe(true);
    const data = res.data as { pieceCount: number; jobIds: string[] };
    expect(data.pieceCount).toBe(1);
    expect(data.jobIds).toHaveLength(1);
  });
});
