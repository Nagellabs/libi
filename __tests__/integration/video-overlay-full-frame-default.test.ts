/**
 * add_overlay({kind:"video"}) WITHOUT an explicit rect defaults the rect to the
 * full composition frame and sets fit:"cover" — a video reads like a base scene.
 * An explicit rect / fit is honored. Non-video kinds still require a rect.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { loadManifest } from "@/lib/composition/persistence";
import { files } from "@/lib/db/schema";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

import { addOverlay } from "@/mcp/tools/overlay-tools";

const PIECE = "p_ff";

function seedVideoFile(id: string) {
  testDb.insert(files).values({
    id, pieceId: PIECE, filename: `${id}.mp4`, name: `${id}.mp4`, description: "",
    type: "video", contentType: "video/mp4", storagePath: "test", size: 0,
    mediaDuration: 10, hasAudio: false,
  }).run();
}

describe("video overlay full-frame default", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("defaults rect to the full frame + fit:'cover' when no rect is supplied", async () => {
    seedVideoFile("fv");
    const res = await addOverlay({
      pieceId: PIECE, kind: "video", fileId: "fv", startTime: 0, duration: 5,
      z: 0, opacity: 1,
      // no rect
    } as never);
    expect(res.success).toBe(true);
    const overlayId = (res.data as { overlayId: string }).overlayId;

    const m = await loadManifest(PIECE);
    const ov = (m.overlays ?? []).find((o) => o.id === overlayId)!;
    expect(ov).toMatchObject({
      kind: "video",
      fit: "cover",
      rect: { x: 0, y: 0, width: m.width, height: m.height },
    });
  });

  it("honors an explicit rect and fit when supplied", async () => {
    seedVideoFile("fv2");
    const res = await addOverlay({
      pieceId: PIECE, kind: "video", fileId: "fv2", startTime: 0, duration: 5,
      rect: { x: 10, y: 20, width: 320, height: 240 }, fit: "contain",
      z: 0, opacity: 1,
    });
    expect(res.success).toBe(true);
    const overlayId = (res.data as { overlayId: string }).overlayId;

    const m = await loadManifest(PIECE);
    const ov = (m.overlays ?? []).find((o) => o.id === overlayId)!;
    expect(ov).toMatchObject({
      kind: "video",
      fit: "contain",
      rect: { x: 10, y: 20, width: 320, height: 240 },
    });
  });

  it("still requires a rect for non-video kinds", async () => {
    const res = await addOverlay({
      pieceId: PIECE, kind: "text", content: "hi", startTime: 0, duration: 5,
      z: 0, opacity: 1,
      // no rect
    } as never);
    expect(res.success).toBe(false);
    expect((res as { error?: string }).error).toBe("missing_field");
  });
});
