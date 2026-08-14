import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "../helpers/test-storage";
import { createTestDb, seedPiece } from "../helpers/test-db";
import { saveManifest } from "@/lib/composition/persistence";
import { addOverlay, updateOverlay, getOverlays } from "@/mcp/tools/overlay-tools";
import { files } from "@/lib/db/schema";

// add_overlay now validates image/video fileId ownership against the DB —
// give the handler a test DB with the referenced file row.
let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

const PIECE = "piece-tools-transform";

async function seedEmptyManifest() {
  await saveManifest(PIECE, {
    sceneOrder: [],
    width: 1920,
    height: 1080,
    fps: 30,
    scenes: [],
    overlays: [],
  });
}

describe("overlay tools carry transform/group", () => {
  beforeEach(async () => {
    createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
    testDb.insert(files).values({
      id: "f", pieceId: PIECE, filename: "f.png", name: "f.png", description: "",
      type: "image", storagePath: `${PIECE}/f.png`, contentType: "image/png", size: 1,
    }).run();
    await seedEmptyManifest();
  });
  afterEach(() => cleanupTempDir());

  it("addOverlay converts the `rotation` sugar to transform3d + persists group", async () => {
    const added = await addOverlay({
      pieceId: PIECE,
      kind: "text",
      startTime: 0,
      duration: 2,
      rect: { x: 0, y: 0, width: 100, height: 40 },
      z: 0,
      opacity: 1,
      content: "hi",
      font: "48px Inter",
      color: "#fff",
      align: "center",
      rotation: 15,
      group: "captions",
    } as never);
    expect(added.success).toBe(true);
    const overlayId = (added.data as { overlayId: string }).overlayId;

    const got = await getOverlays({ pieceId: PIECE });
    const o = (got.data as { overlays: Array<Record<string, unknown>> }).overlays.find(
      (x) => x.id === overlayId,
    );
    // `rotation` degrees is INPUT SUGAR → transform3d.rotation.z (radians). No
    // legacy `rotation` field is persisted.
    expect(o?.rotation).toBeUndefined();
    const t3d = o?.transform3d as { rotation: { z: number } } | undefined;
    expect(t3d?.rotation.z).toBeCloseTo((15 * Math.PI) / 180, 6);
    expect(o?.group).toBe("captions");
  });

  it("updateOverlay converts `rotation` sugar to transform3d; sets flipH/group", async () => {
    const added = await addOverlay({
      pieceId: PIECE,
      kind: "image",
      startTime: 0,
      duration: 2,
      rect: { x: 0, y: 0, width: 50, height: 50 },
      z: 0,
      opacity: 1,
      fileId: "f",
    } as never);
    const overlayId = (added.data as { overlayId: string }).overlayId;

    const upd = await updateOverlay({
      pieceId: PIECE,
      overlayId,
      rotation: 90,
      flipH: true,
      group: "stickers",
    } as never);
    expect(upd.success).toBe(true);

    const got = await getOverlays({ pieceId: PIECE });
    const o = (got.data as { overlays: Array<Record<string, unknown>> }).overlays.find(
      (x) => x.id === overlayId,
    );
    expect(o?.rotation).toBeUndefined();
    const t3d = o?.transform3d as { rotation: { z: number } } | undefined;
    expect(t3d?.rotation.z).toBeCloseTo((90 * Math.PI) / 180, 6);
    // A rotation-sugar patch does NOT clear a flip submitted in the same patch.
    expect(o?.flipH).toBe(true);
    expect(o?.group).toBe("stickers");
  });
});
