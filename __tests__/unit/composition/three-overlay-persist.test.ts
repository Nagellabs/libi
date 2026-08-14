import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import {
  addOverlayToManifest,
  loadManifest,
  type PersistedOverlay,
} from "@/lib/composition/persistence";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

const PIECE = "p-three-1";

describe("three overlay persistence", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("round-trips a three overlay on the manifest", async () => {
    const overlay: PersistedOverlay = {
      id: "three-abc",
      kind: "three",
      startTime: 0,
      duration: 4,
      rect: { x: 0, y: 0, width: 1280, height: 720 },
      z: 5,
      opacity: 1,
      sceneFunction: "return ({ progress }) => {};",
      cameraPreset: "ground",
    };
    await addOverlayToManifest(PIECE, overlay);
    const manifest = await loadManifest(PIECE);
    const got = manifest.overlays?.find((o) => o.id === "three-abc");
    expect(got?.kind).toBe("three");
    expect((got as { sceneFunction: string }).sceneFunction).toBe("return ({ progress }) => {};");
    expect((got as { cameraPreset?: string }).cameraPreset).toBe("ground");
  });

  it("round-trips a non-identity transform3d on a three overlay", async () => {
    const transform3d = {
      position: { x: 1.5, y: -2, z: 3 },
      rotation: { x: 0, y: 0.7853981633974483, z: 0 },
      scale: { x: 2, y: 2, z: 2 },
    };
    const overlay: PersistedOverlay = {
      id: "three-xform",
      kind: "three",
      startTime: 0,
      duration: 4,
      rect: { x: 0, y: 0, width: 1280, height: 720 },
      z: 5,
      opacity: 1,
      sceneFunction: "return ({ progress }) => {};",
      cameraPreset: "billboard",
      transform3d,
    };
    await addOverlayToManifest(PIECE, overlay);
    const manifest = await loadManifest(PIECE);
    const got = manifest.overlays?.find((o) => o.id === "three-xform");
    expect(got?.kind).toBe("three");
    // transform3d is plain JSON on the manifest — survives the
    // save (strip code) → load (hydrate code) round-trip intact.
    expect((got as { transform3d?: typeof transform3d }).transform3d).toEqual(transform3d);
  });
});
