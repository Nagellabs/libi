import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { addOverlay, updateOverlay } from "@/mcp/tools/overlay-tools";
import { loadManifest } from "@/lib/composition/persistence";
import { roadCaption } from "@/lib/engine/three-templates";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

async function addOne(pieceId: string): Promise<string> {
  const res = await addOverlay({
    pieceId,
    kind: "three",
    displayName: "Test 3D",
    body: roadCaption({ text: "OLD" }),
    startTime: 0,
    duration: 4,
    rect: { x: 0, y: 0, width: 1280, height: 720 },
    cameraPreset: "ground",
    z: 5,
    opacity: 1,
  });
  return (res.data as { overlayId: string }).overlayId;
}

// update_overlay changes STRUCTURED fields only — the scene body is edited
// directly in the overlay's scene.jsx file, never through a tool.
describe("update_overlay (three structured fields)", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: "p1" });
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("updates cameraPreset of an existing three overlay", async () => {
    const id = await addOne("p1");
    const res = await updateOverlay({
      pieceId: "p1",
      overlayId: id,
      cameraPreset: "angled",
    });
    expect(res.success).toBe(true);
    const m = await loadManifest("p1");
    const ov = m.overlays?.find((o) => o.id === id);
    expect(ov?.kind).toBe("three");
    expect((ov as { cameraPreset?: string }).cameraPreset).toBe("angled");
    // The scene body is untouched by update_overlay.
    expect((ov as { sceneFunction: string }).sceneFunction).toContain("OLD");
  });

  it("leaves untouched fields intact (partial patch)", async () => {
    const id = await addOne("p1");
    const res = await updateOverlay({ pieceId: "p1", overlayId: id, z: 9 });
    expect(res.success).toBe(true);
    const m = await loadManifest("p1");
    const ov = m.overlays?.find((o) => o.id === id) as { z: number; cameraPreset?: string };
    expect(ov.z).toBe(9);
    expect(ov.cameraPreset).toBe("ground"); // unchanged
  });

  it("returns a miss for an unknown overlayId", async () => {
    const res = await updateOverlay({ pieceId: "p1", overlayId: "nope", z: 1 });
    expect(res.success).toBe(false);
  });
});
