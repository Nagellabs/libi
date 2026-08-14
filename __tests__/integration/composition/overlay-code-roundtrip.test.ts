import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import {
  loadManifest,
  saveManifest,
  type CompositionManifest,
  type PersistedOverlay,
} from "@/lib/composition/persistence";

const three = (body: string): PersistedOverlay => ({
  id: "three-1",
  kind: "three",
  startTime: 0,
  duration: 1,
  rect: { x: 0, y: 0, width: 10, height: 10 },
  z: 0,
  opacity: 1,
  sceneFunction: body,
});

const base = (ov: PersistedOverlay[]): CompositionManifest => ({
  sceneOrder: [],
  width: 1920,
  height: 1080,
  fps: 30,
  scenes: [],
  overlays: ov,
});

const PIECE = "piece1";
let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

describe("overlay code round-trip through persistence", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("save strips code from composition.json but load hydrates it back", async () => {
    await saveManifest(PIECE, base([three("scene.add(mesh)")]));

    const storage = new LocalFileStorage(tempDir);
    const raw = JSON.parse((await storage.read(PIECE, "composition.json")).toString("utf-8"));
    expect(raw.overlays[0].sceneFunction).toBe(""); // stripped on disk

    const reloaded = await loadManifest(PIECE);
    expect((reloaded.overlays![0] as { sceneFunction: string }).sceneFunction).toBe("scene.add(mesh)"); // hydrated from file
  });

  it("removing an overlay sweeps its dir on next save", async () => {
    await saveManifest(PIECE, base([three("x")]));
    await saveManifest(PIECE, base([])); // overlay gone

    const storage = new LocalFileStorage(tempDir);
    const after = await storage.exists(PIECE, "overlays/three-1/scene.jsx");
    expect(after).toBe(false);
  });
});
