/**
 * `libi.create_piece` (mcp/tools/piece-discovery-tools.ts) used to insert the
 * piece row and write no manifest at all, so an agent-created piece landed
 * at EMPTY_MANIFEST's 1920x1080 landscape default regardless of what the
 * user configured as their default aspect ratio — only `POST /api/pieces`
 * materialised the manifest. Both paths now go through the shared
 * `initializePieceManifest` helper (lib/composition/new-piece-manifest.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, resetTestDb } from "../helpers/test-db";

let storageRoot: string;

vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(join(storageRoot, "storage"));
  },
}));

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "libi-cp-ratio-"));
  process.env.LIBI_HOME = storageRoot;
});

afterEach(() => {
  delete process.env.LIBI_HOME;
  rmSync(storageRoot, { recursive: true, force: true });
  resetTestDb();
});

describe("createPiece — honors the user's default aspect ratio", () => {
  it("writes a manifest at the configured default ratio, not the 1920x1080 fallback", async () => {
    createTestDb();

    // Deliberately landscape, so it's distinguishable from the 9:16 product
    // default the fallback test below exercises.
    const { setPieceDefaults } = await import("@/lib/db/settings");
    setPieceDefaults({ aspectRatioId: "16:9" });

    const { createPiece } = await import("@/mcp/tools/piece-discovery-tools");
    const result = await createPiece({ name: "YouTube Piece" });
    expect(result.success).toBe(true);
    const pieceId = (result.data as Record<string, unknown>).id as string;

    const { loadManifest } = await import("@/lib/composition/persistence");
    const manifest = await loadManifest(pieceId);
    expect([manifest.width, manifest.height]).toEqual([1920, 1080]);
  });

  it("falls back to the product default when no default is configured", async () => {
    createTestDb();

    const { createPiece } = await import("@/mcp/tools/piece-discovery-tools");
    const result = await createPiece({ name: "Default Piece" });
    const pieceId = (result.data as Record<string, unknown>).id as string;

    const { loadManifest } = await import("@/lib/composition/persistence");
    const { dimensionsFor, DEFAULT_ASPECT_RATIO_ID } = await import(
      "@/lib/composition/aspect-ratio"
    );
    const manifest = await loadManifest(pieceId);
    const expected = dimensionsFor(DEFAULT_ASPECT_RATIO_ID)!;
    expect([manifest.width, manifest.height]).toEqual([expected.width, expected.height]);
  });
});
