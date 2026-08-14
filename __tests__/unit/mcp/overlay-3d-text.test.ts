import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { loadManifest, type PersistedOverlay } from "@/lib/composition/persistence";
import { addOverlay, updateOverlay } from "@/mcp/tools/overlay-tools";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

const PIECE = "p-3d-1";

type TextOverlayShape = Extract<PersistedOverlay, { kind: "text" }>;

describe("add_overlay / update_overlay accept 3D text + new reveal modes", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("add_overlay (text) persists a threeD block + a karaoke reveal", async () => {
    const res = await addOverlay({
      pieceId: PIECE,
      kind: "text",
      startTime: 0,
      duration: 2,
      rect: { x: 100, y: 200, width: 600, height: 160 },
      z: 5,
      opacity: 1,
      content: "Hello 3D",
      threeD: {
        depth: 24,
        bevel: 3,
        frontColor: "#ff00ff",
        sideColor: "#330033",
        lighting: "dramatic",
        tilt: "lowAngle",
      },
      reveal: { mode: "karaoke", highlightColor: "#ffd700" },
    } as never);
    expect(res.success).toBe(true);
    const overlayId = (res.data as { overlayId: string }).overlayId;

    const manifest = await loadManifest(PIECE);
    const got = manifest.overlays?.find((o) => o.id === overlayId) as TextOverlayShape;
    expect(got.kind).toBe("text");
    expect(got.threeD).toEqual({
      depth: 24,
      bevel: 3,
      frontColor: "#ff00ff",
      sideColor: "#330033",
      lighting: "dramatic",
      tilt: "lowAngle",
    });
    expect(got.reveal).toEqual({ mode: "karaoke", highlightColor: "#ffd700" });
  });

  it("update_overlay can set threeD on an existing text overlay", async () => {
    const res = await addOverlay({
      pieceId: PIECE,
      kind: "text",
      startTime: 0,
      duration: 2,
      rect: { x: 0, y: 0, width: 400, height: 120 },
      z: 3,
      opacity: 1,
      content: "Flat first",
    } as never);
    const overlayId = (res.data as { overlayId: string }).overlayId;

    const upd = await updateOverlay({
      pieceId: PIECE,
      overlayId,
      threeD: { depth: 40, tilt: "highAngle" },
      reveal: { mode: "word-current" },
    } as never);
    expect(upd.success).toBe(true);

    const manifest = await loadManifest(PIECE);
    const got = manifest.overlays?.find((o) => o.id === overlayId) as TextOverlayShape;
    expect(got.threeD).toEqual({ depth: 40, tilt: "highAngle" });
    expect(got.reveal).toEqual({ mode: "word-current" });
    // Pre-existing fields untouched.
    expect(got.content).toBe("Flat first");
  });
});
