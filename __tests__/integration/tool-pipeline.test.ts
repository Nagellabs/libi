import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import {
  createTempStorageDir,
  cleanupTempDir,
} from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { eq } from "drizzle-orm";
import { pieces } from "@/lib/db/schema/sqlite";
import type { ToolContext } from "@/mcp/tools/types";

// -- Mock DB to use in-memory SQLite via createTestDb --
let testDb: ReturnType<typeof createTestDb>;

vi.mock("@/lib/db/client", () => ({
  getDb: () => testDb,
}));

// -- Mock storage to use a real LocalFileStorage backed by a temp dir --
let tempDir: string;

vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

// Import AFTER mocks are set up — overlay-tools, composition-tools, and
// piece-tools use the real draw-function validator and real persistence (which hits
// our mocked storage).
import { addOverlay } from "@/mcp/tools/overlay-tools";
import { getComposition } from "@/mcp/tools/composition-tools";
import { updatePieceName } from "@/mcp/tools/piece-tools";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { pieceId: "integ-piece-1", ...overrides };
}

const VALID_DRAW = `const { ctx, width, height } = context;
ctx.fillStyle = '#000';
ctx.fillRect(0, 0, width, height);`;

describe("tool-pipeline integration (real persistence + real storage)", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: "integ-piece-1", name: "Integration Piece" });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  // ---------------------------------------------------------------
  // 1. Full scene lifecycle
  // ---------------------------------------------------------------
  // ---------------------------------------------------------------
  // 2. Draw function security — eval() blocked by real validator
  // ---------------------------------------------------------------
  it("blocks draw functions containing eval()", async () => {
    const ctx = makeCtx();

    const result = await addOverlay({
      pieceId: ctx.pieceId,
      kind: "code",
      displayName: "Evil Layer",
      startTime: 0,
      duration: 1,
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      body: "eval('steal')",
    } as never);

    expect(result.success).toBe(false);
    expect(result.error).toContain("eval() calls");
  });

  // ---------------------------------------------------------------
  // 3. Piece name — nameSetByUser flag
  // ---------------------------------------------------------------
  it("respects nameSetByUser flag when updating piece name", async () => {
    const ctx = makeCtx();

    // First update succeeds (nameSetByUser is false)
    const r1 = await updatePieceName(ctx, { pieceId: ctx.pieceId, name: "AI Chosen Name" });
    expect(r1.success).toBe(true);

    const [row1] = testDb
      .select()
      .from(pieces)
      .where(eq(pieces.id, "integ-piece-1"))
      .all();
    expect(row1.name).toBe("AI Chosen Name");

    // Now set nameSetByUser = true to simulate user renaming
    testDb
      .update(pieces)
      .set({ nameSetByUser: true })
      .where(eq(pieces.id, "integ-piece-1"))
      .run();

    // Second update — name should be skipped, description still applied
    const r2 = await updatePieceName(ctx, {
      pieceId: ctx.pieceId,
      name: "Should Be Ignored",
      description: "Still updated",
    });
    expect(r2.success).toBe(true);

    const [row2] = testDb
      .select()
      .from(pieces)
      .where(eq(pieces.id, "integ-piece-1"))
      .all();
    expect(row2.name).toBe("AI Chosen Name"); // unchanged
    expect(row2.description).toBe("Still updated");
  });
});
