/**
 * `libi.duplicate_file` into many pieces in one call (targetPieceIds / targetPieceFolderId): one copy per
 * piece with its own row and bytes, the source's rights and provenance on every copy, `perPiece` for an
 * apply_ops op, a refusal that stores nothing, and the single-target form unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { files, folders, pieces } from "@/lib/db/schema/sqlite";
import { getDb } from "@/lib/db/client";
import { getStorage, resetStorage } from "@/lib/storage";
import { duplicateFile } from "@/mcp/tools/file-tools";
import { duplicateFileSchema } from "@/mcp/tools/schemas";
import { parseAudioRights } from "@/lib/audio-rights/types";

let tmp: string;
const COPYRIGHTED = JSON.stringify({ class: "copyrighted", track: { title: "Dreams", artist: "Fleetwood Mac" }, decidedBy: "provenance", decidedAt: "2026-09-01T00:00:00.000Z" });

beforeEach(async () => {
  tmp = createTempStorageDir();
  resetStorage?.();
  const db = createTestDb();
  db.insert(folders).values({ id: "fold", name: "Dreams" } as never).run();
  db.insert(folders).values({ id: "sub", name: "Sub", parentFolderId: "fold" } as never).run();
  for (const [id, folderId] of [["src", null], ["a", "fold"], ["b", "fold"], ["c", "sub"], ["loose", null]] as const) {
    db.insert(pieces).values({ id, name: id.toUpperCase(), folderId } as never).run();
  }
  db.insert(files).values({
    id: "song", pieceId: "src", filename: "song.mp3", name: "Dreams", description: "from youtube", type: "audio", storagePath: "src/song.mp3",
    contentType: "audio/mpeg", size: 5, mediaDuration: 228, hasAudio: true, audioRights: COPYRIGHTED,
  } as never).run();
  const storage = await getStorage();
  await storage.save("src", "song.mp3", Buffer.from("MP3BYTES"), "audio/mpeg");
});
afterEach(() => {
  resetTestDb();
  cleanupTempDir(tmp);
});

const rows = () => getDb().select().from(files).all();

describe("libi.duplicate_file into many pieces", () => {
  it("copies into each piece: own row, own bytes, the rights on every copy, perPiece for apply_ops", async () => {
    const r = await duplicateFile({ fileId: "song", targetPieceIds: ["a", "b", "loose"] });
    expect(r.success).toBe(true);
    const data = r.data as { files: Array<{ pieceId: string; fileId: string }>; perPiece: Record<string, { fileId: string }>; sourceFileId: string };
    expect(data.files.map((f) => f.pieceId)).toEqual(["a", "b", "loose"]);
    expect(data.sourceFileId).toBe("song");
    expect(new Set(data.files.map((f) => f.fileId)).size).toBe(3);
    expect(data.perPiece).toEqual(Object.fromEntries(data.files.map((f) => [f.pieceId, { fileId: f.fileId }])));
    for (const f of data.files) {
      const row = rows().find((x) => x.id === f.fileId)!;
      expect(row.pieceId).toBe(f.pieceId);
      expect(row.name).toBe("Dreams");
      expect(parseAudioRights(row.audioRights)).toMatchObject({ class: "copyrighted", track: { title: "Dreams", artist: "Fleetwood Mac" } });
      expect(fs.readFileSync(path.join(tmp, "storage", f.pieceId, row.filename), "utf8")).toBe("MP3BYTES");
    }
    // The source is untouched.
    expect(rows().find((x) => x.id === "song")!.pieceId).toBe("src");
  });

  it("a folder is its pieces (recursive adds the subfolders'); an empty or missing folder is refused", async () => {
    const flat = await duplicateFile({ fileId: "song", targetPieceFolderId: "fold" });
    expect(Object.keys((flat.data as { perPiece: object }).perPiece).sort()).toEqual(["a", "b"]);
    const deep = await duplicateFile({ fileId: "song", targetPieceFolderId: "fold", recursive: true });
    expect(Object.keys((deep.data as { perPiece: object }).perPiece).sort()).toEqual(["a", "b", "c"]);
    expect((await duplicateFile({ fileId: "song", targetPieceFolderId: "nope" })).error).toMatch(/no folder nope/);
    getDb().insert(folders).values({ id: "empty", name: "Empty" } as never).run();
    expect((await duplicateFile({ fileId: "song", targetPieceFolderId: "empty" })).error).toMatch(/holds no pieces/);
    expect((await duplicateFile({ fileId: "song", targetPieceIds: ["a"], recursive: true })).error).toMatch(/recursive only goes with targetPieceFolderId/);
  });

  it("an unknown piece refuses the whole call before any copy is made", async () => {
    const before = rows().length;
    const r = await duplicateFile({ fileId: "song", targetPieceIds: ["a", "ghost"] });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no such piece ghost.*Nothing was copied/);
    expect(rows().length).toBe(before);
  });

  it("the source's own piece is not copied into: it keeps the source, and perPiece names it", async () => {
    const r = await duplicateFile({ fileId: "song", targetPieceIds: ["src", "a"] });
    const data = r.data as { files: Array<{ pieceId: string }>; perPiece: Record<string, { fileId: string }>; note: string };
    expect(data.files.map((f) => f.pieceId)).toEqual(["a"]);
    expect(data.perPiece.src).toEqual({ fileId: "song" });
    expect(data.note).toMatch(/source's own piece/);
    expect(rows().filter((x) => x.pieceId === "src")).toHaveLength(1);
    const only = await duplicateFile({ fileId: "song", targetPieceIds: ["src"] });
    expect(only.success).toBe(true);
    expect((only.data as { files: unknown[] }).files).toEqual([]);
  });

  it("refuses mixed targets, no target, a missing source, an over-large list; `name` names every copy", async () => {
    expect((await duplicateFile({ fileId: "song", targetPieceId: "a", targetPieceIds: ["b"] })).error).toMatch(/Mixed targets/);
    expect((await duplicateFile({ fileId: "song" })).error).toMatch(/No target/);
    expect((await duplicateFile({ fileId: "ghost", targetPieceIds: ["a"] })).error).toMatch(/File not found/);
    const many = Array.from({ length: 51 }, (_, i) => `p${i}`);
    expect(duplicateFileSchema.safeParse({ fileId: "song", targetPieceIds: many }).success).toBe(false);
    const named = await duplicateFile({ fileId: "song", targetPieceIds: ["a", "b"], name: "Bed" });
    for (const f of (named.data as { files: Array<{ fileId: string }> }).files) expect(rows().find((x) => x.id === f.fileId)!.name).toBe("Bed");
  });

  it("a second copy into the same piece takes a free filename, as a single copy always did", async () => {
    await duplicateFile({ fileId: "song", targetPieceIds: ["a"] });
    const again = await duplicateFile({ fileId: "song", targetPieceIds: ["a"] });
    const id = (again.data as { files: Array<{ fileId: string }> }).files[0].fileId;
    expect(rows().find((x) => x.id === id)!.filename).toBe("song (1).mp3");
  });
});

describe("the single-target form is unchanged", () => {
  it("answers the file record, into a piece or global", async () => {
    const r = await duplicateFile({ fileId: "song", targetPieceId: "a" });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ pieceId: "a", filename: "song.mp3", name: "Dreams", sourceFileId: "song" });
    expect((r.data as Record<string, unknown>).files).toBeUndefined();
    const global = await duplicateFile({ fileId: "song", targetPieceId: null });
    expect(global.success).toBe(true);
    expect((global.data as { pieceId: string | null }).pieceId).toBeNull();
    expect((await duplicateFile({ fileId: "song", targetPieceId: "ghost" })).error).toBe("Piece not found: ghost");
    expect(rows().find((x) => x.id === (r.data as { fileId: string }).fileId)!.audioRights).toBe(COPYRIGHTED);
  });
});
