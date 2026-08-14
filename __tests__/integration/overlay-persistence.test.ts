/**
 * Integration: overlays survive round-trip on the manifest AND are
 * cascaded out when their referenced file is deleted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import {
  addOverlayToManifest,
  loadManifest,
  saveManifest,
  removeReferencesToFile,
  updateOverlayInManifest,
  removeOverlayFromManifest,
  reorderOverlaysInManifest,
  type PersistedOverlay,
} from "@/lib/composition/persistence";
import { readOverlayCode, writeOverlayCode } from "@/lib/overlays/code-files";
import { updateOverlay } from "@/mcp/tools/overlay-tools";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

const PIECE = "p1";
const FID = "f-vid";

describe("overlay persistence", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("round-trips a text overlay through the manifest", async () => {
    const t: PersistedOverlay = {
      id: "o1", kind: "text", startTime: 0, duration: 1,
      rect: { x: 0, y: 0, width: 100, height: 20 }, z: 0, opacity: 1,
      content: "hi", font: "16px Inter", color: "#fff", align: "left",
    };
    await addOverlayToManifest(PIECE, t);
    const manifest = await loadManifest(PIECE);
    expect(manifest.overlays).toHaveLength(1);
    expect(manifest.overlays?.[0]).toEqual(t);
  });

  it("cascades image/video overlays when their file is deleted", async () => {
    await addOverlayToManifest(PIECE, {
      id: "o-img", kind: "image", fileId: FID,
      startTime: 0, duration: 1,
      rect: { x: 0, y: 0, width: 50, height: 50 }, z: 0, opacity: 1,
    });
    await addOverlayToManifest(PIECE, {
      id: "o-text", kind: "text",
      startTime: 0, duration: 1,
      rect: { x: 0, y: 0, width: 50, height: 50 }, z: 0, opacity: 1,
      content: "stays", font: "", color: "", align: "left",
    });

    const result = await removeReferencesToFile(PIECE, FID);
    expect(result.removedOverlays).toEqual(["o-img"]);

    const manifest = await loadManifest(PIECE);
    expect(manifest.overlays?.map((o) => o.id)).toEqual(["o-text"]);
  });

  it("updateOverlayInManifest patches only the target overlay", async () => {
    await addOverlayToManifest(PIECE, {
      id: "o1", kind: "text", startTime: 0, duration: 1,
      rect: { x: 0, y: 0, width: 50, height: 50 }, z: 0, opacity: 1,
      content: "before", font: "", color: "", align: "left",
    });
    const ok = await updateOverlayInManifest(PIECE, "o1", { z: 5 });
    expect(ok).toBe(true);
    const m = await loadManifest(PIECE);
    expect(m.overlays?.[0].z).toBe(5);
  });

  it("removeOverlayFromManifest returns false for missing id", async () => {
    const ok = await removeOverlayFromManifest(PIECE, "missing");
    expect(ok).toBe(false);
  });

  it("does NOT zero an existing three overlay's scene.jsx on a structured PATCH with an empty in-memory body", async () => {
    // DATA-LOSS regression: a `three` overlay whose scene.jsx holds real code
    // must keep that code when a structured transform PATCH saves a manifest
    // whose in-memory `sceneFunction` has gone empty (the hydration-gap / 0-byte
    // condition observed live). writeOverlayCode must treat a blank body as
    // "no write" and preserve the last-good file.
    const GOOD = "scene.add(new THREE.Mesh()); // non-empty 3D scene body";
    const three: PersistedOverlay = {
      id: "three-1", kind: "three", startTime: 0, duration: 2,
      rect: { x: 0, y: 0, width: 200, height: 200 }, z: 0, opacity: 1,
      sceneFunction: GOOD,
    } as PersistedOverlay;
    await addOverlayToManifest(PIECE, three);

    // Sanity: the body was written to scene.jsx.
    expect(await readOverlayCode(PIECE, three)).toBe(GOOD);

    // Simulate the bug condition: a save whose in-memory overlay body is "".
    // (Mirrors a structured PATCH operating on an un-hydrated / transiently
    // empty manifest — e.g. a "Reset transform" / size drag.)
    const emptied = await loadManifest(PIECE);
    (emptied.overlays![0] as { sceneFunction: string }).sceneFunction = "";
    await saveManifest(PIECE, emptied);

    // The on-disk scene.jsx must be UNCHANGED (last-good preserved, not zeroed).
    expect(await readOverlayCode(PIECE, three)).toBe(GOOD);
    // And after a fresh hydrate the body is restored from the file.
    const reloaded = await loadManifest(PIECE);
    expect((reloaded.overlays![0] as { sceneFunction: string }).sceneFunction).toBe(GOOD);
  });

  it("writeOverlayCode skips a blank body instead of clobbering an existing file", async () => {
    const GOOD = "drawText(ctx, 'hi'); // real draw body";
    const code: PersistedOverlay = {
      id: "code-1", kind: "code", startTime: 0, duration: 1,
      rect: { x: 0, y: 0, width: 10, height: 10 }, z: 0, opacity: 1,
      drawFunction: GOOD,
    } as PersistedOverlay;
    await writeOverlayCode(PIECE, code);
    expect(await readOverlayCode(PIECE, code)).toBe(GOOD);

    // Empty + whitespace-only bodies must not overwrite the good file.
    await writeOverlayCode(PIECE, { ...code, drawFunction: "" } as PersistedOverlay);
    expect(await readOverlayCode(PIECE, code)).toBe(GOOD);
    await writeOverlayCode(PIECE, { ...code, drawFunction: "   \n\t" } as PersistedOverlay);
    expect(await readOverlayCode(PIECE, code)).toBe(GOOD);
  });

  it("persists a three overlay's full-frame rect x/y through the update_overlay PATCH path", async () => {
    // REGRESSION (Issue 1): dragging X/Y on a `three` overlay (whose rect fills
    // the 720x1280 canvas by default) must STICK. The old clampRectToFrame
    // collapsed x/y to 0 whenever width===frameW, silently reverting every
    // full-frame drag. updateOverlay() clamps via the piece's manifest dims, so
    // the manifest must carry width/height first.
    const manifest = await loadManifest(PIECE);
    manifest.width = 720;
    manifest.height = 1280;
    await saveManifest(PIECE, manifest);

    const three: PersistedOverlay = {
      id: "three-rect", kind: "three", startTime: 0, duration: 2,
      rect: { x: 0, y: 0, width: 720, height: 1280 }, z: 0, opacity: 1,
      sceneFunction: "scene.add(new THREE.Mesh()); // body",
    } as PersistedOverlay;
    await addOverlayToManifest(PIECE, three);

    // Move the full-frame box to (200,150) — the exact failing repro.
    const res = await updateOverlay({
      pieceId: PIECE,
      overlayId: "three-rect",
      rect: { x: 200, y: 150, width: 720, height: 1280 },
    } as never);
    expect(res.success).toBe(true);

    const reloaded = await loadManifest(PIECE);
    const o = reloaded.overlays?.find((x) => x.id === "three-rect");
    // x/y persist; width/height stay frame-capped.
    expect(o?.rect).toEqual({ x: 200, y: 150, width: 720, height: 1280 });
  });

  it("still keeps a sub-frame overlay rect fully inside the canvas (off-edge clamp intact)", async () => {
    const manifest = await loadManifest(PIECE);
    manifest.width = 720;
    manifest.height = 1280;
    await saveManifest(PIECE, manifest);

    await addOverlayToManifest(PIECE, {
      id: "img-rect", kind: "image", fileId: FID,
      startTime: 0, duration: 1,
      rect: { x: 0, y: 0, width: 300, height: 400 }, z: 0, opacity: 1,
    });

    // Push it off the right/bottom — must shift back fully inside, not overflow.
    await updateOverlay({
      pieceId: PIECE,
      overlayId: "img-rect",
      rect: { x: 700, y: 1270, width: 300, height: 400 },
    } as never);

    const reloaded = await loadManifest(PIECE);
    const o = reloaded.overlays?.find((x) => x.id === "img-rect");
    expect(o?.rect).toEqual({ x: 420, y: 880, width: 300, height: 400 });
  });

  it("reorderOverlaysInManifest sets z by sequence position", async () => {
    await addOverlayToManifest(PIECE, {
      id: "a", kind: "text", startTime: 0, duration: 1,
      rect: { x: 0, y: 0, width: 10, height: 10 }, z: 10, opacity: 1,
      content: "", font: "", color: "", align: "left",
    });
    await addOverlayToManifest(PIECE, {
      id: "b", kind: "text", startTime: 0, duration: 1,
      rect: { x: 0, y: 0, width: 10, height: 10 }, z: 20, opacity: 1,
      content: "", font: "", color: "", align: "left",
    });
    await reorderOverlaysInManifest(PIECE, ["b", "a"]);
    const m = await loadManifest(PIECE);
    const byId = Object.fromEntries((m.overlays ?? []).map((o) => [o.id, o.z]));
    expect(byId).toEqual({ b: 0, a: 1 });
  });
});
