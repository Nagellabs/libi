/**
 * agent-speed B5: `libi.upload_file` with `pieceIds` / `pieceFolderId` stores the file once per piece in ONE
 * call, each piece with its own row and storage copy, rights stamped per file, and answers in the shape
 * `libi.apply_ops` takes as `perPiece`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import type { FileStorage } from "@/lib/storage/types";

vi.mock("@/mcp/jobs-client", () => ({
  enqueueJobOnServer: vi.fn(() => Promise.resolve({ status: "new", jobId: "job-1", clientKey: "ck-1" })),
  logProxyGenEnqueueFailure: vi.fn(),
  LibiServerUnavailableError: class LibiServerUnavailableError extends Error {},
}));
let probeCalls = 0;
vi.mock("child_process", () => ({
  execFile: (...callArgs: unknown[]) => {
    probeCalls++;
    const cb = callArgs[callArgs.length - 1] as (e: Error | null, o: { stdout: string; stderr: string }) => void;
    cb(null, { stdout: JSON.stringify({ format: { duration: "3" }, streams: [{ codec_type: "audio", codec_name: "mp3" }] }), stderr: "" });
  },
}));
let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
const mockStorage: FileStorage = {
  save: vi.fn(),
  read: vi.fn(),
  exists: vi.fn(),
  delete: vi.fn(),
  deletePieceDir: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  localPath: vi.fn(),
  realPathForRead: vi.fn(),
};
vi.mock("@/lib/storage", () => ({ getStorage: vi.fn(() => Promise.resolve(mockStorage)) }));

import { uploadFile } from "@/mcp/tools/file-tools";
import { parseAudioRights } from "@/lib/audio-rights/types";
import { files, folders, pieces } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const COPY = { class: "copyrighted" as const, source: { url: "https://x.example/a" }, decidedBy: "provenance" as const, decidedAt: "2026-09-27T00:00:00.000Z" };

let dir: string;
let filePath: string;

beforeEach(() => {
  testDb = createTestDb();
  seedPiece(testDb, { id: "p1", name: "One" });
  seedPiece(testDb, { id: "p2", name: "Two" });
  seedPiece(testDb, { id: "p3", name: "Three" });
  vi.clearAllMocks();
  probeCalls = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-upload-many-"));
  filePath = path.join(dir, "song.mp3");
  fs.writeFileSync(filePath, "song-bytes");
  vi.mocked(mockStorage.save).mockImplementation(async (pieceId: string | null, filename: string) => `${pieceId}/${filename}`);
  vi.mocked(mockStorage.localPath).mockImplementation((pieceId: string | null, filename: string) => `/storage/${pieceId}/${filename}`);
});

const rowOf = (fileId: string) => testDb.select().from(files).where(eq(files.id, fileId)).get()!;
type Many = { files: { pieceId: string; fileId: string }[]; perPiece: Record<string, { fileId: string }> };

describe("libi.upload_file({ pieceIds })", () => {
  it("stores one file per piece, each with its own row and storage copy, and answers in apply_ops perPiece shape", async () => {
    const r = await uploadFile({ pieceId: "" }, { filePath, pieceIds: ["p1", "p2", "p3"] } as never);
    expect(r.success).toBe(true);
    const data = r.data as unknown as Many;
    expect(data.files.map((f) => f.pieceId)).toEqual(["p1", "p2", "p3"]);
    expect(new Set(data.files.map((f) => f.fileId)).size).toBe(3);
    for (const f of data.files) {
      const row = rowOf(f.fileId);
      expect(row.pieceId).toBe(f.pieceId);
      expect(row.filename).toBe("song.mp3");
      expect(row.type).toBe("audio");
      expect(data.perPiece[f.pieceId]).toEqual({ fileId: f.fileId });
    }
    // One physical copy per piece, under that piece's own directory.
    expect(vi.mocked(mockStorage.save).mock.calls.map((c) => c[0])).toEqual(["p1", "p2", "p3"]);
    // The file is read and probed once, not once per piece.
    expect(probeCalls).toBe(1);
  });

  it("stamps each file's audio rights like a single upload: the user's own file is owned", async () => {
    const r = await uploadFile({ pieceId: "" }, { filePath, pieceIds: ["p1", "p2"] } as never);
    for (const f of (r.data as unknown as Many).files) {
      expect(parseAudioRights(rowOf(f.fileId).audioRights)).toMatchObject({ class: "owned", decidedBy: "provenance" });
    }
  });

  it("derivedFromFileId: every copy inherits the source's rights, and the source is checked once, before any byte is stored", async () => {
    testDb.insert(files).values({ id: "song", pieceId: "p1", filename: "song-src.mp3", name: "s", description: "", type: "audio", storagePath: "p1/song-src.mp3", hasAudio: true, audioRights: JSON.stringify(COPY) }).run();
    const r = await uploadFile({ pieceId: "" }, { filePath, pieceIds: ["p2", "p3"], derivedFromFileId: "song" } as never);
    const data = r.data as unknown as Many & { audioRights?: { class: string; inheritedFrom: string } };
    for (const f of data.files) expect(parseAudioRights(rowOf(f.fileId).audioRights)?.class).toBe("copyrighted");
    expect(data.audioRights).toEqual({ class: "copyrighted", inheritedFrom: "song" });

    vi.mocked(mockStorage.save).mockClear();
    const bad = await uploadFile({ pieceId: "" }, { filePath, pieceIds: ["p2", "p3"], derivedFromFileId: "nope" } as never);
    expect(bad.success).toBe(false);
    expect(mockStorage.save).not.toHaveBeenCalled();
  });

  it("aiGeneration is stamped generated on every copy", async () => {
    const r = await uploadFile({ pieceId: "" }, {
      filePath, pieceIds: ["p1", "p2"],
      aiGeneration: { provider: "elevenlabs", model: "music_v1", prompt: "calm piano", startedAt: "2026-09-27T00:00:00.000Z", completedAt: "2026-09-27T00:00:01.000Z", durationMs: 1000 },
    } as never);
    for (const f of (r.data as unknown as Many).files) {
      expect(parseAudioRights(rowOf(f.fileId).audioRights)).toMatchObject({ class: "generated" });
      expect(rowOf(f.fileId).aiGeneration).toContain("calm piano");
    }
  });

  it("a piece named twice is stored once", async () => {
    const r = await uploadFile({ pieceId: "" }, { filePath, pieceIds: ["p1", "p1", "p2"] } as never);
    expect((r.data as unknown as Many).files.map((f) => f.pieceId)).toEqual(["p1", "p2"]);
    expect(testDb.select().from(files).all()).toHaveLength(2);
  });

  it("an unknown piece refuses the whole call before anything is stored", async () => {
    const r = await uploadFile({ pieceId: "" }, { filePath, pieceIds: ["p1", "ghost"] } as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain("ghost");
    expect(mockStorage.save).not.toHaveBeenCalled();
    expect(testDb.select().from(files).all()).toHaveLength(0);
  });

  it("a missing local file is refused like a single upload", async () => {
    const r = await uploadFile({ pieceId: "" }, { filePath: path.join(dir, "nope.mp3"), pieceIds: ["p1", "p2"] } as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain("File not found");
  });

  it("a file already named song.mp3 in one piece lands as 'song (1).mp3' there, and plain in the others", async () => {
    testDb.insert(files).values({ id: "old", pieceId: "p2", filename: "song.mp3", name: "old", description: "", type: "audio", storagePath: "p2/song.mp3" }).run();
    const r = await uploadFile({ pieceId: "" }, { filePath, pieceIds: ["p1", "p2"] } as never);
    const byPiece = Object.fromEntries((r.data as unknown as Many).files.map((f) => [f.pieceId, rowOf(f.fileId).filename]));
    expect(byPiece).toEqual({ p1: "song.mp3", p2: "song (1).mp3" });
  });

  it("one piece failing to store does not stop the others, and is named", async () => {
    vi.mocked(mockStorage.save).mockImplementation(async (pieceId: string | null, filename: string) => {
      if (pieceId === "p2") throw new Error("disk full");
      return `${pieceId}/${filename}`;
    });
    const r = await uploadFile({ pieceId: "" }, { filePath, pieceIds: ["p1", "p2", "p3"] } as never);
    expect(r.success).toBe(true);
    const data = r.data as unknown as Many & { errors: { pieceId: string; error: string }[] };
    expect(data.files.map((f) => f.pieceId)).toEqual(["p1", "p3"]);
    expect(data.errors).toEqual([{ pieceId: "p2", error: expect.stringContaining("disk full") }]);
  });

  it("every piece failing is a failure", async () => {
    vi.mocked(mockStorage.save).mockRejectedValue(new Error("disk full"));
    const r = await uploadFile({ pieceId: "" }, { filePath, pieceIds: ["p1"] } as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain("disk full");
  });
});

describe("libi.upload_file({ pieceFolderId })", () => {
  beforeEach(() => {
    testDb.insert(folders).values({ id: "f1", name: "Dreams" }).run();
    testDb.insert(folders).values({ id: "f2", name: "Sub", parentFolderId: "f1" }).run();
    testDb.update(pieces).set({ folderId: "f1" }).where(eq(pieces.id, "p1")).run();
    testDb.update(pieces).set({ folderId: "f1" }).where(eq(pieces.id, "p2")).run();
    testDb.update(pieces).set({ folderId: "f2" }).where(eq(pieces.id, "p3")).run();
  });

  it("stores into every piece in the folder, not its subfolders unless recursive", async () => {
    const r = await uploadFile({ pieceId: "" }, { filePath, pieceFolderId: "f1" } as never);
    expect((r.data as unknown as Many).files.map((f) => f.pieceId).sort()).toEqual(["p1", "p2"]);
    const rec = await uploadFile({ pieceId: "" }, { filePath, pieceFolderId: "f1", recursive: true } as never);
    expect((rec.data as unknown as Many).files.map((f) => f.pieceId).sort()).toEqual(["p1", "p2", "p3"]);
  });

  it("refuses an unknown folder and an empty one", async () => {
    expect((await uploadFile({ pieceId: "" }, { filePath, pieceFolderId: "nope" } as never)).error).toMatch(/no folder nope/);
    testDb.insert(folders).values({ id: "empty", name: "Empty" }).run();
    expect((await uploadFile({ pieceId: "" }, { filePath, pieceFolderId: "empty" } as never)).error).toMatch(/holds no pieces/);
  });
});

describe("libi.upload_file target validation", () => {
  it("refuses mixing pieceId with pieceIds or pieceFolderId, and naming no piece at all", async () => {
    for (const extra of [{ pieceIds: ["p2"] }, { pieceFolderId: "f1" }, { pieceIds: ["p2"], pieceFolderId: "f1" }]) {
      const r = await uploadFile({ pieceId: "p1" }, { filePath, pieceId: "p1", ...extra } as never);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/exactly one of pieceId, pieceIds, pieceFolderId/);
    }
    const none = await uploadFile({ pieceId: "" }, { filePath } as never);
    expect(none.success).toBe(false);
    expect(none.error).toMatch(/exactly one of pieceId, pieceIds, pieceFolderId/);
    expect(mockStorage.save).not.toHaveBeenCalled();
  });

  it("refuses the asset-folder folderId and recursive-without-folder with a multi-piece target", async () => {
    const a = await uploadFile({ pieceId: "" }, { filePath, pieceIds: ["p1", "p2"], folderId: "af" } as never);
    expect(a.error).toMatch(/asset folder/i);
    const b = await uploadFile({ pieceId: "" }, { filePath, pieceIds: ["p1"], recursive: true } as never);
    expect(b.error).toMatch(/recursive/);
  });

  it("a single pieceId keeps its old behaviour and result shape (no files / perPiece)", async () => {
    const r = await uploadFile({ pieceId: "p1" }, { filePath, pieceId: "p1" } as never);
    expect(r.success).toBe(true);
    const data = r.data as Record<string, unknown>;
    expect(data).toMatchObject({ filename: "song.mp3", type: "audio", contentType: "audio/mpeg" });
    expect(typeof data.fileId).toBe("string");
    expect(data.files).toBeUndefined();
    expect(data.perPiece).toBeUndefined();
  });
});
