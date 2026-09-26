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

const CONTENT_TYPES: Record<string, string> = {
  image: "image/png",
  video: "video/mp4",
  audio: "audio/mpeg",
  document: "application/pdf",
  font: "font/ttf",
  other: "application/octet-stream",
};
const EXTENSIONS: Record<string, string> = {
  image: "png",
  video: "mp4",
  audio: "mp3",
  document: "pdf",
  font: "ttf",
  other: "bin",
};

/** A piece file of a given `files.type`, with a matching content type and
 *  filename unless overridden (a legacy row can carry a mismatched pair). */
function seedTypedFile(
  id: string,
  pieceId: string | null,
  type: string,
  overrides: { filename?: string; contentType?: string } = {},
) {
  const filename = overrides.filename ?? `${id}.${EXTENSIONS[type]}`;
  testDb
    .insert(files)
    .values({
      id,
      pieceId,
      filename,
      name: filename,
      description: "",
      type,
      storagePath: `${pieceId ?? "_global"}/${filename}`,
      contentType: overrides.contentType ?? CONTENT_TYPES[type],
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
    // The image overlay needs an image file (kind gate), so seed a global one.
    seedTypedFile("file-global-img", null, "image");
    const res = await addOverlay({ ...baseAdd, kind: "image", fileId: "file-global-img" });
    expect(res.success).toBe(true);
    const manifest = await loadManifest("p1");
    expect(manifest.overlays?.some((o) => o.kind === "image" && o.fileId === "file-global-img")).toBe(true);
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

  it("refuses an audio file on an image overlay (add) and a video on an image overlay (update)", async () => {
    seedTypedFile("a1", "p1", "audio");
    const add = await addOverlay({ ...baseAdd, kind: "image", fileId: "a1" } as never);
    expect(add.success).toBe(false);
    expect(add.error).toBe("file_kind_mismatch");
    expect((add.data as { hint?: string }).hint).toBe(
      "File `a1` is an `audio` file; an `image` overlay needs an `image` file.",
    );

    seedTypedFile("img1", "p1", "image");
    seedTypedFile("v1", "p1", "video");
    const img = await addOverlay({ ...baseAdd, kind: "image", fileId: "img1" } as never);
    expect(img.success).toBe(true);
    const overlayId = (img.data as { overlayId: string }).overlayId;
    const upd = await updateOverlay({ pieceId: "p1", overlayId, fileId: "v1" } as never);
    expect(upd.success).toBe(false);
    expect(upd.error).toBe("file_kind_mismatch");
    // Nothing persisted: only the image overlay, still on its image file.
    const manifest = await loadManifest("p1");
    expect(manifest.overlays).toHaveLength(1);
    const o = manifest.overlays?.find((ov) => ov.id === overlayId);
    expect(o?.kind === "image" && o.fileId).toBe("img1");
  });

  it("refuses an image file on a video overlay, and a document on an image overlay", async () => {
    seedTypedFile("img1", "p1", "image");
    seedTypedFile("doc1", "p1", "document");
    const vid = await addOverlay({ ...baseAdd, kind: "video", fileId: "img1" } as never);
    expect(vid.error).toBe("file_kind_mismatch");
    const img = await addOverlay({ ...baseAdd, kind: "image", fileId: "doc1" } as never);
    expect(img.error).toBe("file_kind_mismatch");
  });

  it("refuses a fileId on a text overlay", async () => {
    seedTypedFile("img1", "p1", "image");
    const txt = await addOverlay({ ...baseAdd, kind: "text", content: "hi" } as never);
    const overlayId = (txt.data as { overlayId: string }).overlayId;
    const upd = await updateOverlay({ pieceId: "p1", overlayId, fileId: "img1" } as never);
    expect(upd.success).toBe(false);
    expect(upd.error).toBe("file_id_not_supported");
    expect((upd.data as { hint?: string }).hint).toBe(
      `Only image and video overlays take a \`fileId\`; \`${overlayId}\` is a \`text\` overlay.`,
    );
    const manifest = await loadManifest("p1");
    expect((manifest.overlays?.[0] as { fileId?: string }).fileId).toBeUndefined();
  });

  it("update_overlay accepts a same-kind fileId (image → another image)", async () => {
    seedTypedFile("img1", "p1", "image");
    seedTypedFile("img2", "p1", "image");
    const img = await addOverlay({ ...baseAdd, kind: "image", fileId: "img1" } as never);
    const overlayId = (img.data as { overlayId: string }).overlayId;
    const upd = await updateOverlay({ pieceId: "p1", overlayId, fileId: "img2" } as never);
    expect(upd.success).toBe(true);
    const manifest = await loadManifest("p1");
    const o = manifest.overlays?.find((ov) => ov.id === overlayId);
    expect(o?.kind === "image" && o.fileId).toBe("img2");
  });

  it("a legacy file stored as `other` but named .png is still accepted on an image overlay", async () => {
    seedTypedFile("old1", "p1", "other", { filename: "logo.png", contentType: "application/octet-stream" });
    const add = await addOverlay({ ...baseAdd, kind: "image", fileId: "old1" } as never);
    expect(add.success).toBe(true);
  });

  it("a legacy `other` file whose name says audio is refused on an image overlay", async () => {
    seedTypedFile("old2", "p1", "other", { filename: "vo.mp3", contentType: "application/octet-stream" });
    const add = await addOverlay({ ...baseAdd, kind: "image", fileId: "old2" } as never);
    expect(add.error).toBe("file_kind_mismatch");
  });

  it("an `other` file with no informative type or name still passes (today's behaviour)", async () => {
    seedTypedFile("blob1", "p1", "other", { filename: "blob", contentType: "application/octet-stream" });
    const add = await addOverlay({ ...baseAdd, kind: "image", fileId: "blob1" } as never);
    expect(add.success).toBe(true);
  });

  // Fix round 1: libi.save_asset stores the agent's free-text type verbatim.
  it("a save_asset-style type is re-derived from the content type: image/png passes, audio/voiceover is refused", async () => {
    seedTypedFile("sa-img", "p1", "image/png", { filename: "gen.png", contentType: "image/png" });
    seedTypedFile("sa-vo", "p1", "audio/voiceover", { filename: "vo.mp3", contentType: "audio/mpeg" });
    const ok = await addOverlay({ ...baseAdd, kind: "image", fileId: "sa-img" } as never);
    expect(ok.success).toBe(true);
    const bad = await addOverlay({ ...baseAdd, kind: "image", fileId: "sa-vo" } as never);
    expect(bad.error).toBe("file_kind_mismatch");
    expect((bad.data as { hint?: string }).hint).toBe("File `sa-vo` is an `audio` file; an `image` overlay needs an `image` file.");
  });
});
