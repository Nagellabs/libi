import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { pieces } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import type { ToolContext } from "@/mcp/tools/types";

// Create the test DB instance at module scope so vi.mock factory can close over it.
// We reassign `testDb` in beforeEach and the mock always returns the current value.
let testDb: ReturnType<typeof createTestDb>;

vi.mock("@/lib/db/client", () => ({
  getDb: () => testDb,
}));

import { updatePieceName, updatePieceDescription } from "@/mcp/tools/piece-tools";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { pieceId: "test-piece-1", ...overrides };
}

describe("updatePieceName", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedPiece(testDb);
  });

  it("updates the name when nameSetByUser is false", async () => {
    const ctx = makeCtx();

    const result = await updatePieceName(ctx, { pieceId: "test-piece-1", name: "Shiny New Name" });

    expect(result.success).toBe(true);
    expect(result.data?.name).toBe("Shiny New Name");

    const [row] = testDb.select().from(pieces).where(eq(pieces.id, "test-piece-1")).all();
    expect(row.name).toBe("Shiny New Name");
  });

  it("skips the name update when nameSetByUser is true", async () => {
    // Re-seed with nameSetByUser = true
    testDb = createTestDb();
    seedPiece(testDb, { nameSetByUser: true });

    const ctx = makeCtx();

    const result = await updatePieceName(ctx, { pieceId: "test-piece-1", name: "Ignored Name" });

    expect(result.success).toBe(true);
    // The tool still reports the requested name in data...
    expect(result.data?.name).toBe("Ignored Name");

    // ...but the DB row keeps the original name
    const [row] = testDb.select().from(pieces).where(eq(pieces.id, "test-piece-1")).all();
    expect(row.name).toBe("Test Piece");
  });

  it("also updates description when provided", async () => {
    const ctx = makeCtx();

    await updatePieceName(ctx, { pieceId: "test-piece-1", name: "New Name", description: "A great video" });

    const [row] = testDb.select().from(pieces).where(eq(pieces.id, "test-piece-1")).all();
    expect(row.description).toBe("A great video");
  });

  it("leaves description unchanged when not provided", async () => {
    const ctx = makeCtx();

    await updatePieceName(ctx, { pieceId: "test-piece-1", name: "Another Name" });

    const [row] = testDb.select().from(pieces).where(eq(pieces.id, "test-piece-1")).all();
    expect(row.description).toBeNull();
  });
});

describe("updatePieceDescription", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedPiece(testDb);
  });

  it("updates the description", async () => {
    const ctx = makeCtx();

    const result = await updatePieceDescription(ctx, { pieceId: "test-piece-1", description: "Short and sweet" });

    expect(result.success).toBe(true);
    expect(result.data?.description).toBe("Short and sweet");

    const [row] = testDb.select().from(pieces).where(eq(pieces.id, "test-piece-1")).all();
    expect(row.description).toBe("Short and sweet");
  });
});
