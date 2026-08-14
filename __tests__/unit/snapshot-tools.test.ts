import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "../helpers/test-storage";
import {
  getPieceStateTool,
  commitDraftTool,
  discardDraftTool,
  restoreSnapshotTool,
  compareStatesTool,
} from "@/mcp/tools/snapshot-tools";
import { pieces } from "@/lib/db/schema/sqlite";
import { saveManifest } from "@/lib/composition/persistence";

describe("MCP snapshot tools", () => {
  beforeEach(() => { createTestDb(); createTempStorageDir(); });
  afterEach(() => { resetTestDb(); cleanupTempDir(); });

  it("getPieceState returns hasDraft + empty history for new piece", async () => {
    const db = createTestDb();
    const [piece] = await db.insert(pieces).values({ name: "p" }).returning();
    const result = await getPieceStateTool({ pieceId: piece.id });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hasDraft).toBe(false);
      expect(result.data.recentSnapshots).toEqual([]);
    }
  });

  it("commitDraft flips hasDraft to false", async () => {
    const db = createTestDb();
    const [piece] = await db.insert(pieces).values({ name: "p" }).returning();
    await saveManifest(piece.id, { sceneOrder: [], width: 1920, height: 1080, fps: 30, scenes: [] });
    const result = await commitDraftTool({ pieceId: piece.id, summary: "x" });
    expect(result.success).toBe(true);
    const state = await getPieceStateTool({ pieceId: piece.id });
    if (state.success) expect(state.data.hasDraft).toBe(false);
  });

  it("discardDraft refuses without confirm", async () => {
    // @ts-expect-error - missing confirm
    const result = await discardDraftTool({ pieceId: "p1" });
    expect(result.success).toBe(false);
  });

  it("compareStates returns diff", async () => {
    const db = createTestDb();
    const [piece] = await db.insert(pieces).values({ name: "p" }).returning();
    await saveManifest(piece.id, { sceneOrder: ["s1"], width: 1920, height: 1080, fps: 30, scenes: [{ id: "s1", type: "canvas", name: "v2", duration: 1, drawFunction: "" }] });
    const result = await compareStatesTool({ pieceId: piece.id });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hasDraft).toBe(true);
      expect(result.data.scenes.added).toEqual([{ id: "s1", name: "v2" }]);
    }
  });
});
