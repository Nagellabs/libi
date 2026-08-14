import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { assetFolders, pieces } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { createAssetFolder } from "@/lib/asset-folders/repo";

let db: ReturnType<typeof createTestDb>;
beforeEach(() => {
  db = createTestDb();
  seedPiece(db);
});
afterEach(() => resetTestDb());

describe("asset folders — piece deletion cascade", () => {
  it("deleting a piece cascades its asset folders but not global ones", () => {
    const pieceFolder = createAssetFolder({ pieceId: "test-piece-1", name: "P" });
    const globalFolder = createAssetFolder({ pieceId: null, name: "G" });

    // FK cascade (pragma on in test db).
    db.delete(pieces).where(eq(pieces.id, "test-piece-1")).run();

    expect(
      db.select().from(assetFolders).where(eq(assetFolders.id, pieceFolder.id)).all(),
    ).toHaveLength(0);
    expect(
      db.select().from(assetFolders).where(eq(assetFolders.id, globalFolder.id)).all(),
    ).toHaveLength(1);
  });
});
