/**
 * transform3d write-through + rotation input sugar (single rotation authority)
 *
 * There is no legacy `rotation` STORAGE field — `rotation` (degrees) is INPUT
 * SUGAR that update_overlay/add_overlay convert to `transform3d.rotation.z`.
 * `flipH`/`flipV` are CANONICAL, orthogonal fields: the renderer applies flip
 * independently of transform3d, so authoring a transform3d NEVER clears a flip.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { LocalFileStorage } from "@/lib/storage/local";
import { addOverlay, updateOverlay } from "@/mcp/tools/overlay-tools";
import { loadManifest } from "@/lib/composition/persistence";
import { files } from "@/lib/db/schema";

const baseRect = { x: 0, y: 0, width: 100, height: 50 };

type Vec3 = { x: number; y: number; z: number };
/** The persisted-overlay subset these assertions read back from the manifest. */
type PersistedOverlay = {
  id: string;
  z: number;
  flipH?: boolean;
  flipV?: boolean;
  transform3d?: { position: Vec3; rotation: Vec3; scale?: Vec3 };
};

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

// add_overlay now validates image/video fileId ownership against the DB —
// give the handler a test DB with the referenced file rows.
let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

const pieceId = "piece-transform3d-test";

describe("update_overlay — transform3d write-through migration", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: pieceId });
    for (const id of ["file-mirror", "file-mirror2"]) {
      testDb.insert(files).values({
        id, pieceId, filename: `${id}.png`, name: id, description: "",
        type: "image", storagePath: `${pieceId}/${id}.png`, contentType: "image/png", size: 1,
      }).run();
    }
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("an EXPLICIT transform3d PRESERVES the canonical flip fields", async () => {
    const add = await addOverlay({
      pieceId,
      kind: "text",
      startTime: 0,
      duration: 3,
      rect: baseRect,
      z: 1,
      opacity: 1,
      content: "hello",
      font: "32px Inter",
      color: "#ffffff",
      align: "center",
    });
    expect(add.success).toBe(true);
    const overlayId = (add.data as { overlayId: string }).overlayId;

    const flipPatch = await updateOverlay({
      pieceId,
      overlayId,
      flipH: true,
      flipV: false,
    });
    expect(flipPatch.success).toBe(true);

    const beforeManifest = await loadManifest(pieceId);
    const overlayBefore = beforeManifest.overlays?.find((o) => o.id === overlayId) as PersistedOverlay;
    expect(overlayBefore).toBeDefined();
    expect(overlayBefore.flipH).toBe(true);
    expect("rotation" in overlayBefore).toBe(false);

    // Author an EXPLICIT transform3d. Flip is orthogonal — it must SURVIVE.
    const t3d = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0.5 },
      scale: { x: 1, y: 1, z: 1 },
    };
    const up = await updateOverlay({ pieceId, overlayId, transform3d: t3d });
    expect(up.success).toBe(true);

    const afterManifest = await loadManifest(pieceId);
    const overlayAfter = afterManifest.overlays?.find((o) => o.id === overlayId) as PersistedOverlay;
    expect(overlayAfter).toBeDefined();
    expect(overlayAfter.transform3d).toEqual(t3d);
    // Flip fields must SURVIVE the transform3d write-through.
    expect("rotation" in overlayAfter).toBe(false);
    expect(overlayAfter.flipH).toBe(true);
    expect(overlayAfter.flipV).toBe(false);
  });

  it("a transform3d patch keeps a PRE-EXISTING flipH:true", async () => {
    const add = await addOverlay({
      pieceId,
      kind: "image",
      startTime: 0,
      duration: 3,
      rect: baseRect,
      z: 1,
      opacity: 1,
      fileId: "file-mirror",
      flipH: true,
    });
    expect(add.success).toBe(true);
    const overlayId = (add.data as { overlayId: string }).overlayId;

    const beforeManifest = await loadManifest(pieceId);
    const overlayBefore = beforeManifest.overlays?.find((o) => o.id === overlayId) as PersistedOverlay;
    expect(overlayBefore.flipH).toBe(true);

    const t3d = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0.7 },
      scale: { x: 1, y: 1, z: 1 },
    };
    const up = await updateOverlay({ pieceId, overlayId, transform3d: t3d });
    expect(up.success).toBe(true);

    const manifest = await loadManifest(pieceId);
    const o = manifest.overlays?.find((ov) => ov.id === overlayId) as PersistedOverlay;
    // The mirror must not be silently lost by the spin.
    expect(o.flipH).toBe(true);
    expect(o.transform3d).toEqual(t3d);
  });

  it("`rotation` (degrees) is INPUT SUGAR → transform3d.rotation.z; keeps a co-submitted flip", async () => {
    const add = await addOverlay({
      pieceId,
      kind: "text",
      startTime: 0,
      duration: 3,
      rect: baseRect,
      z: 1,
      opacity: 1,
      content: "sugar",
      font: "32px Inter",
      color: "#ffffff",
      align: "center",
    });
    const overlayId = (add.data as { overlayId: string }).overlayId;

    const up = await updateOverlay({ pieceId, overlayId, rotation: 90, flipH: true });
    expect(up.success).toBe(true);

    const manifest = await loadManifest(pieceId);
    const o = manifest.overlays?.find((ov) => ov.id === overlayId) as PersistedOverlay;
    expect("rotation" in o).toBe(false);
    expect(o.transform3d?.rotation.z).toBeCloseTo((90 * Math.PI) / 180, 6);
    // rotation-sugar's synthesized transform3d must NOT clear the co-submitted flip.
    expect(o.flipH).toBe(true);
  });

  it("`rotation` (degrees) sugar keeps a PRE-EXISTING flip", async () => {
    const add = await addOverlay({
      pieceId,
      kind: "image",
      startTime: 0,
      duration: 3,
      rect: baseRect,
      z: 1,
      opacity: 1,
      fileId: "file-mirror2",
      flipV: true,
    });
    const overlayId = (add.data as { overlayId: string }).overlayId;

    const up = await updateOverlay({ pieceId, overlayId, rotation: 45 });
    expect(up.success).toBe(true);

    const manifest = await loadManifest(pieceId);
    const o = manifest.overlays?.find((ov) => ov.id === overlayId) as PersistedOverlay;
    expect(o.transform3d?.rotation.z).toBeCloseTo((45 * Math.PI) / 180, 6);
    expect(o.flipV).toBe(true);
  });

  it("a transform3d patch on an overlay with no flip fields stays clean", async () => {
    const add = await addOverlay({
      pieceId,
      kind: "text",
      startTime: 0,
      duration: 2,
      rect: baseRect,
      z: 0,
      opacity: 1,
      content: "clean",
      font: "24px Inter",
      color: "#fff",
      align: "left",
    });
    expect(add.success).toBe(true);
    const overlayId = (add.data as { overlayId: string }).overlayId;

    const t3d = {
      position: { x: 10, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0.3 },
      scale: { x: 1.5, y: 1.5, z: 1 },
    };
    const up = await updateOverlay({ pieceId, overlayId, transform3d: t3d });
    expect(up.success).toBe(true);

    const manifest = await loadManifest(pieceId);
    const o = manifest.overlays?.find((ov) => ov.id === overlayId) as PersistedOverlay;
    expect(o).toBeDefined();
    expect(o.transform3d).toEqual(t3d);
    expect("rotation" in o).toBe(false);
    expect("flipH" in o).toBe(false);
    expect("flipV" in o).toBe(false);
  });

  it("does NOT change a flip when the patch carries no EXPLICIT transform3d", async () => {
    const add = await addOverlay({
      pieceId,
      kind: "text",
      startTime: 0,
      duration: 2,
      rect: baseRect,
      z: 0,
      opacity: 1,
      content: "legacy",
      font: "24px Inter",
      color: "#fff",
      align: "left",
    });
    const overlayId = (add.data as { overlayId: string }).overlayId;

    await updateOverlay({ pieceId, overlayId, flipV: true });
    await updateOverlay({ pieceId, overlayId, z: 5 });

    const manifest = await loadManifest(pieceId);
    const o = manifest.overlays?.find((ov) => ov.id === overlayId) as PersistedOverlay;
    expect(o.flipV).toBe(true);
    expect(o.z).toBe(5);
  });
});
