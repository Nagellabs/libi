import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { addOverlay } from "@/mcp/tools/overlay-tools";
import { loadManifest } from "@/lib/composition/persistence";
import { roadCaption } from "@/lib/engine/three-templates";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

describe("add_overlay (three)", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: "p1" });
    seedPiece(testDb, { id: "p2" });
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("persists a valid three overlay and returns the code file path", async () => {
    const res = await addOverlay({
      pieceId: "p1",
      kind: "three",
      displayName: "Test 3D",
      body: roadCaption({ text: "HELLO" }),
      startTime: 0,
      duration: 4,
      rect: { x: 0, y: 0, width: 1280, height: 720 },
      cameraPreset: "ground",
      z: 5,
      opacity: 1,
    });
    expect(res.success).toBe(true);
    const overlayId = (res.data as { overlayId: string }).overlayId;
    expect((res.data as { codeFilePath?: string }).codeFilePath).toBe(`overlays/${overlayId}/scene.jsx`);
    const manifest = await loadManifest("p1");
    expect(manifest.overlays?.some((o) => o.kind === "three")).toBe(true);
  });

  it("scaffolds a starter body when none is given", async () => {
    const res = await addOverlay({
      pieceId: "p1",
      kind: "three",
      displayName: "Test 3D",
      startTime: 0,
      duration: 4,
      rect: { x: 0, y: 0, width: 100, height: 100 },
      z: 0,
      opacity: 1,
    });
    expect(res.success).toBe(true);
    const manifest = await loadManifest("p1");
    const o = manifest.overlays?.find((ov) => ov.kind === "three");
    if (o?.kind === "three") expect(o.sceneFunction.length).toBeGreaterThan(0);
  });

  it("rejects a three overlay created WITHOUT a displayName (mandatory track label)", async () => {
    const res = await addOverlay({
      pieceId: "p1",
      kind: "three",
      body: roadCaption({ text: "HELLO" }),
      startTime: 0,
      duration: 4,
      rect: { x: 0, y: 0, width: 100, height: 100 },
      z: 0,
      opacity: 1,
    });
    expect(res.success).toBe(false);
    expect((res as { error?: string }).error).toBe("missing_field");
  });

  it("rejects a body with a forbidden pattern", async () => {
    const res = await addOverlay({
      pieceId: "p2",
      kind: "three",
      displayName: "Test 3D",
      body: "fetch('/evil'); return () => {};",
      startTime: 0,
      duration: 4,
      rect: { x: 0, y: 0, width: 100, height: 100 },
      z: 0,
      opacity: 1,
    });
    expect(res.success).toBe(false);
  });

  it("succeeds but returns a warning for a body with a huge geometry count", async () => {
    const res = await addOverlay({
      pieceId: "p1",
      kind: "three",
      displayName: "Test 3D",
      body: "const g = new THREE.SphereGeometry(1, 2000, 2000); scene.add(new THREE.Mesh(g)); return () => {};",
      startTime: 0,
      duration: 4,
      rect: { x: 0, y: 0, width: 100, height: 100 },
      z: 0,
      opacity: 1,
    });
    expect(res.success).toBe(true);
    expect(res.data?.warning).toBeTruthy();
    expect(typeof res.data?.warning).toBe("string");
  });
});
