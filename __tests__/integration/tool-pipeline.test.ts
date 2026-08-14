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

// Import AFTER mocks are set up — scene-tools, composition-tools, and
// piece-tools use the real scene-validator and real persistence (which hits
// our mocked storage).
import {
  createScene,
  updateScene,
  deleteScene,
  reorderScenes,
  loadSceneData,
} from "@/mcp/tools/scene-tools";
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
  it("full scene lifecycle: create, get, load, update, reorder, delete", async () => {
    const ctx = makeCtx();

    // Create two scenes
    const r1 = await createScene(ctx, {
      pieceId: ctx.pieceId,
      name: "Scene A",
      duration: 3,
      drawFunction: VALID_DRAW,
    });
    expect(r1.success).toBe(true);
    const sceneAId = r1.data!.sceneId as string;

    const r2 = await createScene(ctx, {
      pieceId: ctx.pieceId,
      name: "Scene B",
      duration: 5,
      drawFunction: VALID_DRAW,
    });
    expect(r2.success).toBe(true);
    const sceneBId = r2.data!.sceneId as string;

    // getComposition should show both scenes in creation order
    const comp = await getComposition(ctx);
    expect(comp.success).toBe(true);
    const manifest = comp.data!.manifest as { sceneOrder: string[] };
    expect(manifest.sceneOrder).toEqual([sceneAId, sceneBId]);
    const scenes = comp.data!.scenes as { id: string }[];
    expect(scenes).toHaveLength(2);

    // loadSceneData for scene A
    const loadA = await loadSceneData(ctx, { pieceId: ctx.pieceId, sceneId: sceneAId });
    expect(loadA.success).toBe(true);
    const sceneA = loadA.data!.scene as { name: string };
    expect(sceneA.name).toBe("Scene A");

    // updateScene — change name of scene A
    const upd = await updateScene(ctx, { pieceId: ctx.pieceId, sceneId: sceneAId, name: "Scene A (v2)" });
    expect(upd.success).toBe(true);

    const reloadA = await loadSceneData(ctx, { pieceId: ctx.pieceId, sceneId: sceneAId });
    const updatedScene = reloadA.data!.scene as { name: string };
    expect(updatedScene.name).toBe("Scene A (v2)");

    // reorderScenes — swap order
    const reorder = await reorderScenes(ctx, { pieceId: ctx.pieceId, sceneIds: [sceneBId, sceneAId] });
    expect(reorder.success).toBe(true);

    const comp2 = await getComposition(ctx);
    const manifest2 = comp2.data!.manifest as { sceneOrder: string[] };
    expect(manifest2.sceneOrder).toEqual([sceneBId, sceneAId]);

    // deleteScene — remove scene B
    const del = await deleteScene(ctx, { pieceId: ctx.pieceId, sceneId: sceneBId });
    expect(del.success).toBe(true);

    // Verify final state: only scene A remains
    const comp3 = await getComposition(ctx);
    const manifest3 = comp3.data!.manifest as { sceneOrder: string[] };
    expect(manifest3.sceneOrder).toEqual([sceneAId]);
    const finalScenes = comp3.data!.scenes as { id: string }[];
    expect(finalScenes).toHaveLength(1);
    expect(finalScenes[0].id).toBe(sceneAId);
  });

  // ---------------------------------------------------------------
  // 2. Draw function security — eval() blocked by real validator
  // ---------------------------------------------------------------
  it("blocks draw functions containing eval()", async () => {
    const ctx = makeCtx();

    const result = await createScene(ctx, {
      pieceId: ctx.pieceId,
      name: "Evil Scene",
      duration: 1,
      drawFunction: "eval('steal')",
    });

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
