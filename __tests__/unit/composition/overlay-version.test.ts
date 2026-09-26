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

const PIECE = "p-version-1";

async function readVersion(id: string): Promise<number | undefined> {
  const manifest = await loadManifest(PIECE);
  const got = manifest.overlays?.find((o) => o.id === id) as
    | (PersistedOverlay & { version?: number })
    | undefined;
  return got?.version;
}

describe("per-overlay monotonic version", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("bumps version on every save (no version ⇒ 1, then 2)", async () => {
    const overlay: PersistedOverlay = {
      id: "cap-v",
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
    // No `version` was authored on the original.
    expect(await readVersion("cap-v")).toBeUndefined();

    const ok1 = await updateOverlayInManifest(PIECE, "cap-v", { opacity: 0.5 });
    expect(ok1).toBe(true);
    expect(await readVersion("cap-v")).toBe(1);

    const ok2 = await updateOverlayInManifest(PIECE, "cap-v", { opacity: 0.25 });
    expect(ok2).toBe(true);
    expect(await readVersion("cap-v")).toBe(2);
  });

  // Final review I2, defense in depth: whatever a caller hands in, a patch can
  // never change an overlay's identity or smuggle a code body onto it.
  it("never lets a patch set id, kind, drawFunction or sceneFunction", async () => {
    const overlay: PersistedOverlay = {
      id: "txt-guard",
      kind: "text",
      startTime: 0,
      duration: 1,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      z: 0,
      opacity: 1,
      content: "hi",
      font: "20px Inter",
      color: "#fff",
      align: "left",
    };
    await addOverlayToManifest(PIECE, overlay);
    const ok = await updateOverlayInManifest(PIECE, "txt-guard", {
      id: "other",
      kind: "three",
      sceneFunction: "return () => {};",
      drawFunction: "x",
      color: "#f00",
    } as never);
    expect(ok).toBe(true);
    const got = (await loadManifest(PIECE)).overlays!.find((o) => o.id === "txt-guard") as Record<string, unknown> | undefined;
    expect(got).toBeDefined();
    expect(got!.kind).toBe("text");
    expect(got).not.toHaveProperty("sceneFunction");
    expect(got).not.toHaveProperty("drawFunction");
    expect(got!.color).toBe("#f00");
  });
});
