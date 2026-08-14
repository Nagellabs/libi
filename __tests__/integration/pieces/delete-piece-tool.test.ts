import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { deletePiece } from "@/mcp/tools/piece-discovery-tools";
import { getOpenedPieceId, setOpenedPieceId } from "@/lib/editor-state";

describe("deletePiece (MCP tool)", () => {
  beforeEach(() => createTestDb());
  afterEach(() => {
    resetTestDb();
    setOpenedPieceId(null);
  });

  it("deletes the piece and reports success + wasOpen:false", async () => {
    seedPiece(getDb() as never, { id: "p1" });
    const result = await deletePiece({ pieceId: "p1" });
    expect(result).toEqual({ success: true, data: { pieceId: "p1", wasOpen: false } });
    expect(getDb().select().from(pieces).where(eq(pieces.id, "p1")).all()).toEqual([]);
  });

  it("returns piece_not_found for an unknown id", async () => {
    const result = await deletePiece({ pieceId: "nope" });
    expect(result).toEqual({ success: false, error: "piece_not_found" });
  });

  it("clears the opened-piece pointer when deleting the open piece", async () => {
    seedPiece(getDb() as never, { id: "open1" });
    setOpenedPieceId("open1");
    const result = await deletePiece({ pieceId: "open1" });
    expect(result).toEqual({ success: true, data: { pieceId: "open1", wasOpen: true } });
    expect(getOpenedPieceId()).toBeNull();
  });

  it("leaves a different opened piece pointer untouched", async () => {
    seedPiece(getDb() as never, { id: "a" });
    seedPiece(getDb() as never, { id: "b" });
    setOpenedPieceId("b");
    await deletePiece({ pieceId: "a" });
    expect(getOpenedPieceId()).toBe("b");
  });
});
