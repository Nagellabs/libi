/**
 * Adding a VIDEO OVERLAY whose source file has audio auto-creates a linked
 * inline AudioClip (linkedOverlayId). A silent source creates none. Mirrors
 * video-scene-creates-inline-audio.test.ts but for the overlay path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { loadManifest, removeReferencesToFile } from "@/lib/composition/persistence";
import { files } from "@/lib/db/schema";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

import { addOverlay, updateOverlay, removeOverlayTool } from "@/mcp/tools/overlay-tools";

const PIECE = "p1";

function seedFile(id: string, hasAudio: boolean) {
  testDb.insert(files).values({
    id,
    pieceId: PIECE,
    filename: `${id}.mp4`,
    name: `${id}.mp4`,
    description: "",
    type: "video",
    contentType: "video/mp4",
    storagePath: "test",
    size: 0,
    mediaDuration: 10,
    hasAudio,
  }).run();
}

describe("video overlay inline audio", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("creates exactly one linked clip when the source has audio", async () => {
    seedFile("fa", true);
    const res = await addOverlay({
      pieceId: PIECE, kind: "video", fileId: "fa", startTime: 2, duration: 4,
      rect: { x: 0, y: 0, width: 100, height: 100 },
      trim: { start: 1, end: 5 }, z: 0, opacity: 1,
    });
    expect(res.success).toBe(true);
    const overlayId = (res.data as { overlayId: string }).overlayId;

    const m = await loadManifest(PIECE);
    expect(m.audioClips ?? []).toHaveLength(1);
    expect(m.audioClips![0]).toMatchObject({
      kind: "inline",
      fileId: "fa",
      linkedOverlayId: overlayId,
      startTime: 2,
      duration: 4,
      trimStart: 1,
      volume: 1,
      enabled: true,
    });
  });

  it("creates no clip when the source has no audio", async () => {
    seedFile("fs", false);
    const res = await addOverlay({
      pieceId: PIECE, kind: "video", fileId: "fs", startTime: 0, duration: 3,
      rect: { x: 0, y: 0, width: 100, height: 100 }, z: 0, opacity: 1,
    });
    expect(res.success).toBe(true);

    const m = await loadManifest(PIECE);
    expect(m.audioClips ?? []).toHaveLength(0);
  });

  it("rejects an unknown fileId up-front (ownership gate); nothing persists", async () => {
    // Pre-ownership-gate this succeeded silently and only the inline-audio
    // lookup missed; now a fileId in neither piece nor global files is a
    // structured rejection (see validateOverlayFileId in overlay-tools).
    const res = await addOverlay({
      pieceId: PIECE, kind: "video", fileId: "ghost", startTime: 0, duration: 3,
      rect: { x: 0, y: 0, width: 100, height: 100 }, z: 0, opacity: 1,
    });
    expect(res.success).toBe(false);
    expect((res as { error?: string }).error).toBe("file_not_found");
    const m = await loadManifest(PIECE);
    expect(m.overlays ?? []).toHaveLength(0);
    expect(m.audioClips ?? []).toHaveLength(0);
  });

  it("creates no clip for a GLOBAL file (piece-scoped lookup miss is non-fatal)", async () => {
    // A global file passes the ownership gate, but the inline-audio path's
    // piece-scoped lookup misses it — the add still succeeds, just without a
    // linked clip (the pre-existing lookup-miss-non-fatal contract).
    testDb.insert(files).values({
      id: "fg", pieceId: null, filename: "fg.mp4", name: "fg.mp4", description: "",
      type: "video", contentType: "video/mp4", storagePath: "test", size: 0,
      mediaDuration: 10, hasAudio: true,
    }).run();
    const res = await addOverlay({
      pieceId: PIECE, kind: "video", fileId: "fg", startTime: 0, duration: 3,
      rect: { x: 0, y: 0, width: 100, height: 100 }, z: 0, opacity: 1,
    });
    expect(res.success).toBe(true);
    const m = await loadManifest(PIECE);
    expect(m.audioClips ?? []).toHaveLength(0);
  });

  it("removing a video overlay cascades to its linked clip", async () => {
    seedFile("fa", true);
    const add = await addOverlay({
      pieceId: PIECE, kind: "video", fileId: "fa", startTime: 0, duration: 4,
      rect: { x: 0, y: 0, width: 100, height: 100 }, z: 0, opacity: 1,
    });
    const overlayId = (add.data as { overlayId: string }).overlayId;
    expect((await loadManifest(PIECE)).audioClips).toHaveLength(1);

    const rm = await removeOverlayTool({ pieceId: PIECE, overlayId });
    expect(rm.success).toBe(true);
    const m = await loadManifest(PIECE);
    expect(m.overlays ?? []).toHaveLength(0);
    expect(m.audioClips ?? []).toHaveLength(0);
  });

  it("re-timing/re-trimming a video overlay follows the linked clip", async () => {
    seedFile("fa", true);
    const add = await addOverlay({
      pieceId: PIECE, kind: "video", fileId: "fa", startTime: 0, duration: 4,
      rect: { x: 0, y: 0, width: 100, height: 100 },
      trim: { start: 0, end: 4 }, z: 0, opacity: 1,
    });
    const overlayId = (add.data as { overlayId: string }).overlayId;

    const upd = await updateOverlay({
      pieceId: PIECE, overlayId, startTime: 3, duration: 2, trim: { start: 1, end: 3 },
    });
    expect(upd.success).toBe(true);

    const m = await loadManifest(PIECE);
    expect(m.audioClips![0]).toMatchObject({
      linkedOverlayId: overlayId,
      startTime: 3,
      duration: 2,
      trimStart: 1,
    });
  });

  it("deleting the file removes both the video overlay and its linked clip", async () => {
    seedFile("fa", true);
    const add = await addOverlay({
      pieceId: PIECE, kind: "video", fileId: "fa", startTime: 0, duration: 4,
      rect: { x: 0, y: 0, width: 100, height: 100 }, z: 0, opacity: 1,
    });
    const overlayId = (add.data as { overlayId: string }).overlayId;

    const summary = await removeReferencesToFile(PIECE, "fa");
    expect(summary.removedOverlays).toContain(overlayId);
    expect(summary.removedClips).toHaveLength(1);

    const m = await loadManifest(PIECE);
    expect(m.overlays ?? []).toHaveLength(0);
    expect(m.audioClips ?? []).toHaveLength(0);
  });
});
