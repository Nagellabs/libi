/**
 * createPiece no longer seeds a default "Scene 1" — new pieces start empty
 * (scenes: []). The preview renders a black canvas + a non-blocking hint
 * instead of the old "reads as broken" empty state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, resetTestDb } from "../helpers/test-db";

let storageRoot: string;

// getStorage() caches a module-level singleton; re-point it at the temp dir
// per test (mirrors video-scene-creates-inline-audio.test.ts).
vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(join(storageRoot, "storage"));
  },
}));

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "libi-cp-"));
  process.env.LIBI_HOME = storageRoot;
});

afterEach(() => {
  delete process.env.LIBI_HOME;
  rmSync(storageRoot, { recursive: true, force: true });
  resetTestDb();
});

describe("createPiece", () => {
  it("creates a piece with no seeded scene and no defaultSceneId", async () => {
    createTestDb();

    const { createPiece } = await import("@/mcp/tools/piece-discovery-tools");
    const result = await createPiece({ name: "Empty Piece" });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.name).toBe("Empty Piece");
    // The seed block is gone — no defaultSceneId on the result.
    expect("defaultSceneId" in data).toBe(false);

    // No scene was written: either no composition.json yet, or one with an
    // empty scene list / scene order.
    const pieceId = data.id as string;
    const compositionPath = join(storageRoot, "storage", pieceId, "composition.json");
    if (existsSync(compositionPath)) {
      const manifest = JSON.parse(readFileSync(compositionPath, "utf-8"));
      expect(manifest.overlays ?? []).toHaveLength(0);
      expect(manifest.overlays ?? []).toHaveLength(0);
    }
  });

  it("loadManifest yields an empty scene list for a freshly created piece", async () => {
    createTestDb();

    const { createPiece } = await import("@/mcp/tools/piece-discovery-tools");
    const result = await createPiece({ name: "Empty Piece 2" });
    const pieceId = (result.data as Record<string, unknown>).id as string;

    const { loadManifest } = await import("@/lib/composition/persistence");
    const manifest = await loadManifest(pieceId);
    expect(manifest.overlays ?? []).toHaveLength(0);
  });
});
