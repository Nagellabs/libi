import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

// Count how often ONE add_overlay call reads the composition. addOverlay needs
// the frame for up to three things — clamping the rect, defaulting a video
// overlay to full-frame, and the aspect-mismatch check — and each used to load
// it separately. They all describe the same canvas within one request, so the
// read is done once. Nothing else pins that, and it silently regresses the
// moment someone adds a fourth use.
const loadCompositionCalls = { n: 0 };
vi.mock("@/lib/composition/persistence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/composition/persistence")>();
  return {
    ...actual,
    loadComposition: (...args: Parameters<typeof actual.loadComposition>) => {
      loadCompositionCalls.n += 1;
      return actual.loadComposition(...args);
    },
  };
});

const { addOverlay } = await import("@/mcp/tools/overlay-tools");

describe("add_overlay — composition reads", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: "p1" });
    loadCompositionCalls.n = 0;
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("reads the composition once for a text overlay", async () => {
    const res = await addOverlay({
      pieceId: "p1",
      kind: "text",
      content: "hello",
      startTime: 0,
      duration: 2,
      rect: { x: 0, y: 0, width: 400, height: 100 },
      z: 1,
      opacity: 1,
    });
    expect(res.success).toBe(true);
    expect(loadCompositionCalls.n).toBe(1);
  });

  it("still clamps a rect that overflows the frame", async () => {
    // The consolidation must not cost the clamp itself.
    const res = await addOverlay({
      pieceId: "p1",
      kind: "text",
      content: "wide",
      startTime: 0,
      duration: 2,
      rect: { x: 0, y: 0, width: 99999, height: 99999 },
      z: 1,
      opacity: 1,
    });
    expect(res.success).toBe(true);
    const { loadManifest } = await import("@/lib/composition/persistence");
    const m = await loadManifest("p1");
    const o = m.overlays![0];
    expect(o.rect.width).toBeLessThanOrEqual(m.width);
    expect(o.rect.height).toBeLessThanOrEqual(m.height);
  });
});
