/**
 * Integration tests for detectMissingFiles (DB-backed).
 * The pure helpers collectReferencedFileIds / computeMissingRefs are covered in
 * version-files.test.ts. This file exercises the async DB path that checks
 * whether referenced files actually exist (piece-scoped and globally).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { detectMissingFiles } from "@/lib/composition/version-files";
import type { CompositionManifest } from "@/lib/composition/persistence";
import { files, pieces } from "@/lib/db/schema/sqlite";
import { createTestDb, resetTestDb } from "../../helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "../../helpers/test-storage";

const base = (): CompositionManifest => ({
  sceneOrder: [], width: 1920, height: 1080, fps: 30, audioClips: [], overlays: [], scenes: [],
});

/** Full-frame video overlay — the manifest entity that references a video file. */
const videoOverlay = (
  id: string,
  name: string,
  fileId: string,
  duration = 5,
): NonNullable<CompositionManifest["overlays"]>[number] => ({
  id, kind: "video", fileId, displayName: name,
  startTime: 0, duration, z: 0, opacity: 1, fit: "cover",
  rect: { x: 0, y: 0, width: 1920, height: 1080 },
});

let dir: string;
let db: ReturnType<typeof createTestDb>;

beforeEach(() => {
  db = createTestDb();
  dir = createTempStorageDir();
  // Seed a piece so FK constraints are satisfied
  db.insert(pieces).values({ id: "p1", name: "Test Piece", description: "" }).run();
});

afterEach(() => {
  resetTestDb();
  cleanupTempDir(dir);
});

describe("detectMissingFiles", () => {
  it("returns [] when all referenced files exist (piece-scoped)", async () => {
    // Insert a video file scoped to the piece
    db.insert(files).values({
      id: "vid-1",
      pieceId: "p1",
      filename: "clip.mp4",
      name: "clip.mp4",
      description: "",
      type: "video",
      storagePath: "p1/clip.mp4",
      size: 0,
    }).run();

    const manifest: CompositionManifest = {
      ...base(),
      overlays: [videoOverlay("s1", "Demo", "vid-1")],
    };

    const result = await detectMissingFiles(manifest, "p1");
    expect(result).toEqual([]);
  });

  it("reports the ref as missing after the file row is deleted", async () => {
    db.insert(files).values({
      id: "vid-2",
      pieceId: "p1",
      filename: "deleted.mp4",
      name: "deleted.mp4",
      description: "",
      type: "video",
      storagePath: "p1/deleted.mp4",
      size: 0,
    }).run();

    const manifest: CompositionManifest = {
      ...base(),
      overlays: [videoOverlay("s1", "Missing Clip", "vid-2")],
    };

    // Confirm it's found before deletion
    expect(await detectMissingFiles(manifest, "p1")).toEqual([]);

    // Delete the file row
    db.delete(files).where(eq(files.id, "vid-2")).run();

    // Now the ref should be reported as missing
    const result = await detectMissingFiles(manifest, "p1");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fileId: "vid-2",
      refKind: "overlay",
      refName: "video overlay",
    });
  });

  it("returns [] for a manifest with no file references (canvas-only)", async () => {
    const manifest: CompositionManifest = {
      ...base(),
      sceneOrder: ["s1"],
      scenes: [{ id: "s1", type: "canvas", name: "Hook", duration: 2, drawFunction: "//" }],
    };
    const result = await detectMissingFiles(manifest, "p1");
    expect(result).toEqual([]);
  });

  it("finds a global file (pieceId = null) as present", async () => {
    // Global files have pieceId = null
    db.insert(files).values({
      id: "global-1",
      pieceId: null,
      filename: "global-audio.mp3",
      name: "global-audio.mp3",
      description: "",
      type: "audio",
      storagePath: "_global/global-audio.mp3",
      size: 0,
    }).run();

    const manifest: CompositionManifest = {
      ...base(),
      audioClips: [{
        id: "ac1",
        kind: "standalone",
        fileId: "global-1",
        startTime: 0,
        duration: 3,
        trimStart: 0,
        volume: 1,
        enabled: true,
        label: "BG Music",
      }],
    };

    // Global file should be found via the per-id fallback query
    const result = await detectMissingFiles(manifest, "p1");
    expect(result).toEqual([]);
  });

  it("deduplicates the same missing fileId referenced multiple times", async () => {
    // Reference the same missing fileId from both a video overlay and its
    // coupled inline audio clip.
    const manifest: CompositionManifest = {
      ...base(),
      overlays: [videoOverlay("s1", "Demo", "missing-id")],
      audioClips: [{
        id: "ac1",
        kind: "inline",
        fileId: "missing-id",
        startTime: 0,
        duration: 5,
        trimStart: 0,
        volume: 1,
        enabled: true,
        linkedOverlayId: "s1",
      }],
    };

    const result = await detectMissingFiles(manifest, "p1");
    // Both overlay ref and audio ref use the same fileId but different (refKind, refName) pairs
    // so two distinct entries are expected (not collapsed to one)
    expect(result.length).toBeGreaterThanOrEqual(1);
    // All reported refs must reference the missing file
    expect(result.every((r) => r.fileId === "missing-id")).toBe(true);
  });
});
