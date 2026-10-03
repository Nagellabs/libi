/* eslint-disable @typescript-eslint/no-explicit-any -- reads back loosely-typed manifest JSON */
/**
 * update_overlay `keyframes`: a rect change carries the overlay's keyframed rects with it ("follow",
 * the default) or leaves them at the old layout ("pin"). Keyframed rects are absolute and are read
 * INSTEAD of the base rect while a track exists, so pinning them after a move changed nothing visible.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { LocalFileStorage } from "@/lib/storage/local";
import { updateOverlay } from "@/mcp/tools/overlay-tools";
import { loadManifest, saveManifest, type PersistedOverlay } from "@/lib/composition/persistence";
import { updateOverlayToolSchema } from "@/mcp/tools/schemas";

let tempDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(tempDir) }));
let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

const pieceId = "piece-kf-follow";
const BASE = { x: 100, y: 200, width: 400, height: 100 };
const keyed = (extra: Record<string, unknown> = {}) =>
  ({
    id: "ov",
    kind: "image",
    startTime: 0,
    duration: 4,
    rect: BASE,
    z: 1,
    opacity: 1,
    fileId: "f",
    keyframes: {
      rect: {
        keyframes: [
          { t: 0, value: { x: 100, y: 400, width: 400, height: 100 } },
          { t: 1, value: BASE },
        ],
      },
      opacity: { keyframes: [{ t: 0, value: 0 }, { t: 1, value: 1 }] },
    },
    ...extra,
  }) as unknown as PersistedOverlay;

async function overlay(): Promise<Record<string, any>> {
  return (await loadManifest(pieceId)).overlays!.find((o) => o.id === "ov") as unknown as Record<string, any>;
}

describe("update_overlay keyframes: follow | pin", () => {
  beforeEach(async () => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: pieceId });
    await saveManifest(pieceId, { width: 1080, height: 1920, fps: 30, overlays: [keyed()] } as never);
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("moves the keyframed rects with a moved rect by default", async () => {
    const r = await updateOverlay({ pieceId, overlayId: "ov", rect: { x: 300, y: 800, width: 400, height: 100 } });
    expect(r.success).toBe(true);
    expect((r.data as { keyframesFollowed?: boolean }).keyframesFollowed).toBe(true);
    const o = await overlay();
    expect(o.rect).toEqual({ x: 300, y: 800, width: 400, height: 100 });
    expect(o.keyframes.rect.keyframes[0].value).toEqual({ x: 300, y: 1000, width: 400, height: 100 });
    expect(o.keyframes.rect.keyframes[1].value).toEqual({ x: 300, y: 800, width: 400, height: 100 });
    expect(o.keyframes.opacity.keyframes).toHaveLength(2);
    // The mode is a directive, never a stored field.
    expect(o.keyframes).not.toBe("follow");
  });

  it("scales offsets and sizes with a resized rect", async () => {
    await updateOverlay({ pieceId, overlayId: "ov", rect: { x: 100, y: 200, width: 800, height: 50 }, keyframes: "follow" });
    const o = await overlay();
    expect(o.keyframes.rect.keyframes[0].value).toEqual({ x: 100, y: 300, width: 800, height: 50 });
    expect(o.keyframes.rect.keyframes[1].value).toEqual({ x: 100, y: 200, width: 800, height: 50 });
  });

  it("'pin' leaves the keyframes where they were", async () => {
    const r = await updateOverlay({ pieceId, overlayId: "ov", rect: { x: 300, y: 800, width: 400, height: 100 }, keyframes: "pin" });
    expect((r.data as { keyframesFollowed?: boolean }).keyframesFollowed).toBeUndefined();
    const o = await overlay();
    expect(o.rect.x).toBe(300);
    expect(o.keyframes.rect.keyframes[1].value).toEqual(BASE);
  });

  it("does nothing to keyframes when the patch does not move the rect, or there is no rect track", async () => {
    await updateOverlay({ pieceId, overlayId: "ov", opacity: 0.8 });
    expect((await overlay()).keyframes.rect.keyframes[0].value.y).toBe(400);
    await saveManifest(pieceId, { width: 1080, height: 1920, fps: 30, overlays: [keyed({ keyframes: undefined })] } as never);
    const r = await updateOverlay({ pieceId, overlayId: "ov", rect: { x: 0, y: 0, width: 400, height: 100 } });
    expect(r.success).toBe(true);
    expect((await overlay()).keyframes).toBeUndefined();
  });

  it("a point-text position change moves the keyframed rects by the same distance", async () => {
    await saveManifest(pieceId, {
      width: 1080,
      height: 1920,
      fps: 30,
      overlays: [
        keyed({ kind: "text", fileId: undefined, content: "hi", font: "40px Inter", color: "#fff", align: "center", anchor: "top-left", position: { x: 100, y: 200 }, fontSize: 40 }),
      ],
    } as never);
    await updateOverlay({ pieceId, overlayId: "ov", position: { x: 160, y: 260 } });
    const o = await overlay();
    expect(o.keyframes.rect.keyframes[0].value).toMatchObject({ x: 160, y: 460 });
  });

  it("the MCP schema takes only 'follow' or 'pin'", () => {
    expect(updateOverlayToolSchema.safeParse({ pieceId, overlayId: "ov", keyframes: "follow" }).success).toBe(true);
    expect(updateOverlayToolSchema.safeParse({ pieceId, overlayId: "ov", keyframes: { rect: {} } }).success).toBe(false);
  });
});
