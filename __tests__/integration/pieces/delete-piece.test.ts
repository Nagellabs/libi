import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { deletePieceCompletely } from "@/lib/pieces/delete-piece";

describe("deletePieceCompletely", () => {
  beforeEach(() => createTestDb());
  afterEach(() => resetTestDb());

  it("removes the piece row and returns true", async () => {
    seedPiece(getDb() as never, { id: "p1" });
    const ok = await deletePieceCompletely("p1");
    expect(ok).toBe(true);
    expect(getDb().select().from(pieces).where(eq(pieces.id, "p1")).all()).toEqual([]);
  });

  it("returns false for a missing piece", async () => {
    expect(await deletePieceCompletely("nope")).toBe(false);
  });
});
