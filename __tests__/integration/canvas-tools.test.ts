/**
 * Integration: canvas dimension MCP tools — retrieveAssetsDimensions and
 * updateCompositionDimensions. Uses an in-memory DB and a temp storage dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { files } from "@/lib/db/schema/sqlite";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

// Suppress navigationEmitter side-effects — not relevant in unit context
vi.mock("@/lib/navigation-events", () => ({
  navigationEmitter: { emit: vi.fn() },
}));

import {
  retrieveAssetsDimensions,
  updateCompositionDimensions,
} from "@/mcp/tools/canvas-tools";
import { addOverlay } from "@/mcp/tools/overlay-tools";
import { loadManifest } from "@/lib/composition/persistence";
import { updateCompositionDimensionsSchema } from "@/mcp/tools/schemas";

const PIECE = "canvas-test-piece";
const FILE_VIDEO = "file-video-1";
const FILE_IMAGE = "file-image-1";

// Reusable rect that fits inside 1920×1080
const SMALL_RECT = { x: 10, y: 10, width: 200, height: 100 };

describe("retrieveAssetsDimensions", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("returns composition dims and empty arrays when piece has no scenes/overlays", async () => {
    const res = await retrieveAssetsDimensions({ pieceId: PIECE });
    expect(res.success).toBe(true);
    const d = res.data as Record<string, unknown>;
    expect(d.composition).toMatchObject({ width: 1920, height: 1080 });
    expect(d.videoOverlays).toEqual([]);
    expect(d.imageOverlays).toEqual([]);
  });

  it("returns video overlay with rect and dimensions", async () => {
    testDb.insert(files).values({
      id: FILE_VIDEO,
      pieceId: PIECE,
      filename: "clip.mp4",
      name: "Clip",
      description: "",
      type: "video",
      storagePath: `${PIECE}/clip.mp4`,
      size: 0,
      mediaWidth: 640,
      mediaHeight: 1136,
    }).run();

    await addOverlay({
      kind: "video",
      pieceId: PIECE,
      fileId: FILE_VIDEO,
      startTime: 0,
      duration: 2,
      rect: SMALL_RECT,
      z: 0,
      opacity: 1,
    });

    const res = await retrieveAssetsDimensions({ pieceId: PIECE });
    expect(res.success).toBe(true);
    const d = res.data as Record<string, unknown>;
    const overlays = d.videoOverlays as Array<Record<string, unknown>>;
    expect(overlays).toHaveLength(1);
    expect(overlays[0].fileId).toBe(FILE_VIDEO);
    expect(overlays[0].mediaWidth).toBe(640);
    expect(overlays[0].isVertical).toBe(true);
    expect(overlays[0].rect).toMatchObject(SMALL_RECT);
  });

  it("returns image overlay with dimensions when piece has an image overlay", async () => {
    testDb.insert(files).values({
      id: FILE_IMAGE,
      pieceId: PIECE,
      filename: "logo.png",
      name: "Logo",
      description: "",
      type: "image",
      storagePath: `${PIECE}/logo.png`,
      size: 0,
      mediaWidth: 512,
      mediaHeight: 512,
    }).run();

    await addOverlay({
      kind: "image",
      pieceId: PIECE,
      fileId: FILE_IMAGE,
      startTime: 0,
      duration: 3,
      rect: SMALL_RECT,
      z: 1,
      opacity: 0.9,
    });

    const res = await retrieveAssetsDimensions({ pieceId: PIECE });
    expect(res.success).toBe(true);
    const d = res.data as Record<string, unknown>;
    const overlays = d.imageOverlays as Array<Record<string, unknown>>;
    expect(overlays).toHaveLength(1);
    expect(overlays[0].fileId).toBe(FILE_IMAGE);
    expect(overlays[0].mediaWidth).toBe(512);
    expect(overlays[0].isVertical).toBe(false);
  });

  it("returns piece not found error", async () => {
    const res = await retrieveAssetsDimensions({ pieceId: "does-not-exist" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });
});

describe("updateCompositionDimensions", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("patches manifest from 1920×1080 to 576×1024 and returns previous dims", async () => {
    const res = await updateCompositionDimensions({ pieceId: PIECE, width: 576, height: 1024 });
    expect(res.success).toBe(true);
    const d = res.data as Record<string, unknown>;
    expect(d.width).toBe(576);
    expect(d.height).toBe(1024);
    expect(d.previousWidth).toBe(1920);
    expect(d.previousHeight).toBe(1080);
    // Verify persisted
    const m = await loadManifest(PIECE);
    expect(m.width).toBe(576);
    expect(m.height).toBe(1024);
  });

  it("returns warnings for overlays whose rects extend beyond new bounds", async () => {
    // Add an overlay with a rect that fits in 1920×1080 but not 100×100
    await addOverlay({
      kind: "text",
      pieceId: PIECE,
      content: "big text",
      startTime: 0,
      duration: 1,
      rect: { x: 0, y: 0, width: 500, height: 200 },
      font: "16px Inter",
      color: "#fff",
      align: "center",
      z: 0,
      opacity: 1,
    });

    const res = await updateCompositionDimensions({ pieceId: PIECE, width: 100, height: 100 });
    expect(res.success).toBe(true);
    const d = res.data as Record<string, unknown>;
    const warnings = d.warnings as string[];
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/text/);
  });

  it("returns empty warnings when all overlays fit within new bounds", async () => {
    await addOverlay({
      kind: "text",
      pieceId: PIECE,
      content: "small",
      startTime: 0,
      duration: 1,
      rect: { x: 10, y: 10, width: 50, height: 20 },
      font: "12px Inter",
      color: "#000",
      align: "left",
      z: 0,
      opacity: 1,
    });

    const res = await updateCompositionDimensions({ pieceId: PIECE, width: 300, height: 200 });
    expect(res.success).toBe(true);
    const d = res.data as Record<string, unknown>;
    expect(d.warnings).toEqual([]);
  });

  it("returns piece not found error", async () => {
    const res = await updateCompositionDimensions({
      pieceId: "does-not-exist",
      width: 1280,
      height: 720,
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });

  it("Zod schema rejects width=0 at the type level (positive integer constraint)", () => {
    // The schema uses .positive() so 0 is rejected.
    const result = updateCompositionDimensionsSchema.safeParse({
      pieceId: "p",
      width: 0,
      height: 100,
    });
    expect(result.success).toBe(false);
  });
});
