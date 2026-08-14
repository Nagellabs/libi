import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { addOverlay, updateOverlay } from "@/mcp/tools/overlay-tools";
import { loadManifest } from "@/lib/composition/persistence";
import { files } from "@/lib/db/schema";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

/**
 * fileId ownership gate on `libi.add_overlay` / `libi.update_overlay`
 * (image/video kinds): a usable fileId is in the piece's files ∪ global files
 * (pieceId null) — the same membership `buildComposition`'s `knownFileIds`
 * encodes when it flags an overlay `missing`. Pre-fix, an agent could author a
 * video overlay pointing at ANOTHER piece's file: the preview showed a
 * permanent "Media file missing" placeholder and its parked decoder
 * re-buffered playback every ~1s (the original repro on piece d9c0e0a4…).
 */

function seedFile(id: string, pieceId: string | null) {
  testDb
    .insert(files)
    .values({
      id,
      pieceId,
      filename: `${id}.mp4`,
      name: `${id}.mp4`,
      description: "",
      type: "video",
      storagePath: `${pieceId ?? "_global"}/${id}.mp4`,
      contentType: "video/mp4",
      size: 1,
    })
    .run();
}

const baseAdd = {
  pieceId: "p1",
  startTime: 0,
  duration: 4,
  rect: { x: 0, y: 0, width: 640, height: 360 },
  z: 1,
  opacity: 1,
} as const;

describe("overlay fileId ownership validation", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: "p1" });
    seedPiece(testDb, { id: "p2" });
    seedFile("file-own", "p1"); // belongs to the target piece
    seedFile("file-global", null); // global — usable by any piece
    seedFile("file-other", "p2"); // belongs to a DIFFERENT piece
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("accepts a piece-scoped fileId (video)", async () => {
    const res = await addOverlay({ ...baseAdd, kind: "video", fileId: "file-own" });
    expect(res.success).toBe(true);
    const manifest = await loadManifest("p1");
    expect(manifest.overlays?.some((o) => o.kind === "video" && o.fileId === "file-own")).toBe(true);
  });

  it("accepts a global fileId (image)", async () => {
    const res = await addOverlay({ ...baseAdd, kind: "image", fileId: "file-global" });
    expect(res.success).toBe(true);
    const manifest = await loadManifest("p1");
    expect(manifest.overlays?.some((o) => o.kind === "image" && o.fileId === "file-global")).toBe(true);
  });

  it("rejects a cross-piece fileId with a structured hint; nothing is persisted", async () => {
    const res = await addOverlay({ ...baseAdd, kind: "video", fileId: "file-other" });
    expect(res.success).toBe(false);
    expect((res as { error?: string }).error).toBe("file_not_in_piece");
    const hint = (res.data as { hint?: string })?.hint ?? "";
    expect(hint).toMatch(/duplicate_file|assign_file/);
    const manifest = await loadManifest("p1");
    expect(manifest.overlays ?? []).toHaveLength(0);
  });

  it("rejects an unknown fileId (video + image)", async () => {
    for (const kind of ["video", "image"] as const) {
      const res = await addOverlay({ ...baseAdd, kind, fileId: "file-nope" });
      expect(res.success).toBe(false);
      expect((res as { error?: string }).error).toBe("file_not_found");
    }
    const manifest = await loadManifest("p1");
    expect(manifest.overlays ?? []).toHaveLength(0);
  });

  it("update_overlay rejects a fileId patch pointing at another piece's file", async () => {
    const added = await addOverlay({ ...baseAdd, kind: "video", fileId: "file-own" });
    expect(added.success).toBe(true);
    const overlayId = (added.data as { overlayId: string }).overlayId;

    // `fileId` isn't in the MCP/REST schema today; the guard protects direct
    // callers + any future schema growth. Cast to exercise it.
    const res = await updateOverlay({
      pieceId: "p1",
      overlayId,
      fileId: "file-other",
    } as never);
    expect(res.success).toBe(false);
    expect((res as { error?: string }).error).toBe("file_not_in_piece");
    // The persisted overlay is untouched.
    const manifest = await loadManifest("p1");
    const o = manifest.overlays?.find((ov) => ov.id === overlayId);
    expect(o?.kind === "video" && o.fileId).toBe("file-own");
  });

  it("update_overlay accepts a fileId patch for a global file", async () => {
    const added = await addOverlay({ ...baseAdd, kind: "video", fileId: "file-own" });
    const overlayId = (added.data as { overlayId: string }).overlayId;
    const res = await updateOverlay({
      pieceId: "p1",
      overlayId,
      fileId: "file-global",
    } as never);
    expect(res.success).toBe(true);
  });
});
