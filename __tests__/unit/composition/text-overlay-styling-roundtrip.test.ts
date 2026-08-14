import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import {
  addOverlayToManifest,
  updateOverlayInManifest,
  loadManifest,
  type PersistedOverlay,
} from "@/lib/composition/persistence";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

const PIECE = "p-caption-1";

describe("text overlay styling persistence", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("round-trips background / stroke / shadow / reveal + structured font fields", async () => {
    const overlay: PersistedOverlay = {
      id: "cap-1",
      kind: "text",
      startTime: 0,
      duration: 2.5,
      rect: { x: 100, y: 200, width: 600, height: 160 },
      z: 7,
      opacity: 1,
      content: "Caption line",
      font: "48px Inter",
      color: "#ffffff",
      align: "center",
      fontFamily: "Roboto",
      fontSize: 64,
      fontWeight: 700,
      lineHeight: 1.3,
      background: { color: "#000000", padding: 10, radius: 12 },
      stroke: { color: "#ff0000", width: 4 },
      shadow: { color: "#000000", blur: 8, dx: 2, dy: 3 },
      reveal: { mode: "typewriter", fraction: 0.5 },
    };
    await addOverlayToManifest(PIECE, overlay);

    const manifest = await loadManifest(PIECE);
    const got = manifest.overlays?.find((o) => o.id === "cap-1");
    expect(got?.kind).toBe("text");
    const t = got as Extract<PersistedOverlay, { kind: "text" }>;
    expect(t.fontFamily).toBe("Roboto");
    expect(t.fontSize).toBe(64);
    expect(t.fontWeight).toBe(700);
    expect(t.lineHeight).toBe(1.3);
    expect(t.background).toEqual({ color: "#000000", padding: 10, radius: 12 });
    expect(t.stroke).toEqual({ color: "#ff0000", width: 4 });
    expect(t.shadow).toEqual({ color: "#000000", blur: 8, dx: 2, dy: 3 });
    expect(t.reveal).toEqual({ mode: "typewriter", fraction: 0.5 });
  });

  it("survives an update-patch round-trip", async () => {
    const overlay: PersistedOverlay = {
      id: "cap-2",
      kind: "text",
      startTime: 0,
      duration: 2,
      rect: { x: 0, y: 0, width: 400, height: 120 },
      z: 3,
      opacity: 1,
      content: "Plain",
      font: "48px Inter",
      color: "#ffffff",
      align: "left",
    };
    await addOverlayToManifest(PIECE, overlay);

    const patch: Partial<Extract<PersistedOverlay, { kind: "text" }>> = {
      background: { color: "#111111", radius: 8 },
      reveal: { mode: "fade-words" },
    };
    const ok = await updateOverlayInManifest(PIECE, "cap-2", patch);
    expect(ok).toBe(true);

    const manifest = await loadManifest(PIECE);
    const got = manifest.overlays?.find((o) => o.id === "cap-2") as Extract<
      PersistedOverlay,
      { kind: "text" }
    >;
    expect(got.background).toEqual({ color: "#111111", radius: 8 });
    expect(got.reveal).toEqual({ mode: "fade-words" });
    // Pre-existing fields untouched.
    expect(got.content).toBe("Plain");
  });
});
