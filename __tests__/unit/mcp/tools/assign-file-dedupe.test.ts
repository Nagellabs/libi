/**
 * `assignFile` must dedupe the filename within the DESTINATION scope before
 * writing any bytes — same reasoning as `storeFile`
 * (__tests__/unit/store-file-dedupes-filename.test.ts). `storage.save` ends
 * in `fs.rename`, which replaces unconditionally: without a dedupe, assigning
 * a file into a piece that already holds one with the same name overwrites
 * its bytes on disk while BOTH db rows keep pointing at the shared filename —
 * deleting either then unlinks the shared bytes and orphans the survivor.
 *
 * This is checked against a storage double that actually behaves like a
 * filesystem (a single Map keyed by scope+filename, `save` overwrites
 * unconditionally) rather than a fully-mocked `vi.fn()` — a mock that just
 * records call args would pass even if the real `fs.rename` clobbered the
 * bytes underneath it. The two files are written with DISTINCT content so
 * the test can assert on surviving BYTES, not just surviving names.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import type { FileStorage } from "@/lib/storage/types";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

vi.mock("@/lib/navigation-events", () => ({
  navigationEmitter: { emit: vi.fn() },
}));

/** A storage double that behaves like a real filesystem: one Map keyed by
 *  scope+filename, and `save` overwrites whatever is already at that key —
 *  exactly what `fs.rename` does. Anything that fails to dedupe upstream
 *  will actually lose bytes here, unlike a `vi.fn()` that only records args. */
function makeFakeDiskStorage(): FileStorage & { disk: Map<string, Buffer> } {
  const disk = new Map<string, Buffer>();
  const key = (pieceId: string | null, filename: string) => `${pieceId ?? "_global"}/${filename}`;
  return {
    disk,
    save: vi.fn(async (pieceId: string | null, filename: string, data: Buffer) => {
      const k = key(pieceId, filename);
      disk.set(k, data);
      return k;
    }),
    read: vi.fn(async (pieceId: string | null, filename: string) => {
      const k = key(pieceId, filename);
      const data = disk.get(k);
      if (!data) throw new Error(`ENOENT: ${k}`);
      return data;
    }),
    exists: vi.fn(async (pieceId: string | null, filename: string) => disk.has(key(pieceId, filename))),
    delete: vi.fn(async (pieceId: string | null, filename: string) => {
      disk.delete(key(pieceId, filename));
    }),
    deletePieceDir: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    remove: vi.fn(async () => {}),
    localPath: vi.fn((pieceId: string | null, filename: string) => key(pieceId, filename)),
    realPathForRead: vi.fn(async (pieceId: string | null, filename: string) => key(pieceId, filename)),
  };
}

let fakeStorage: ReturnType<typeof makeFakeDiskStorage>;
vi.mock("@/lib/storage", () => ({
  getStorage: vi.fn(() => Promise.resolve(fakeStorage)),
}));

import { assignFile } from "@/mcp/tools/file-tools";

describe("assignFile dedupes the destination filename", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedPiece(testDb, { id: "piece-a" });
    seedPiece(testDb, { id: "piece-b" });
    fakeStorage = makeFakeDiskStorage();
    vi.clearAllMocks();
  });

  it("does not overwrite a same-named file already at the destination — both survive with distinct bytes", async () => {
    // Destination piece already holds "shot.png" with its own bytes.
    const existingBytes = Buffer.from("existing-destination-bytes");
    fakeStorage.disk.set("piece-b/shot.png", existingBytes);
    const [existingRow] = testDb
      .insert(files)
      .values({
        id: "file-existing",
        pieceId: "piece-b",
        filename: "shot.png",
        name: "shot.png",
        description: "",
        type: "image",
        storagePath: "piece-b/shot.png",
        contentType: "image/png",
        size: existingBytes.byteLength,
      })
      .returning()
      .all();
    expect(existingRow).toBeDefined();

    // Incoming file lives in piece-a with a DIFFERENT filename collision
    // target: same name "shot.png", but distinct bytes.
    const incomingBytes = Buffer.from("incoming-different-bytes");
    fakeStorage.disk.set("piece-a/shot.png", incomingBytes);
    const [incomingRow] = testDb
      .insert(files)
      .values({
        id: "file-incoming",
        pieceId: "piece-a",
        filename: "shot.png",
        name: "shot.png",
        description: "",
        type: "image",
        storagePath: "piece-a/shot.png",
        contentType: "image/png",
        size: incomingBytes.byteLength,
      })
      .returning()
      .all();
    expect(incomingRow).toBeDefined();

    const result = await assignFile({ fileId: "file-incoming", pieceId: "piece-b" });

    expect(result.success).toBe(true);
    const data = result.data as { filename: string; pieceId: string | null };
    // Deduped, not clobbered.
    expect(data.filename).toBe("shot (1).png");

    // The DB row for the moved file must point at the DEDUPED name, not the
    // name that was never actually written (that would be the same bug in a
    // different place).
    const [movedRow] = testDb.select().from(files).where(eq(files.id, "file-incoming")).all();
    expect(movedRow.filename).toBe("shot (1).png");
    expect(movedRow.pieceId).toBe("piece-b");

    // The pre-existing row is untouched.
    const [untouchedRow] = testDb.select().from(files).where(eq(files.id, "file-existing")).all();
    expect(untouchedRow.filename).toBe("shot.png");
    expect(untouchedRow.pieceId).toBe("piece-b");

    // The core invariant: BOTH files' bytes survive, distinct and correct —
    // not just distinct names. This is what a mock that only records save()
    // call args would miss.
    const survivingExisting = await fakeStorage.read("piece-b", "shot.png");
    const survivingMoved = await fakeStorage.read("piece-b", "shot (1).png");
    expect(survivingExisting.equals(existingBytes)).toBe(true);
    expect(survivingMoved.equals(incomingBytes)).toBe(true);
    expect(survivingExisting.equals(survivingMoved)).toBe(false);
  });

  it("assigns without renaming when there is no collision at the destination", async () => {
    const bytes = Buffer.from("only-file");
    fakeStorage.disk.set("piece-a/clip.mp4", bytes);
    testDb
      .insert(files)
      .values({
        id: "file-1",
        pieceId: "piece-a",
        filename: "clip.mp4",
        name: "clip.mp4",
        description: "",
        type: "video",
        storagePath: "piece-a/clip.mp4",
        contentType: "video/mp4",
        size: bytes.byteLength,
      })
      .run();

    const result = await assignFile({ fileId: "file-1", pieceId: "piece-b" });
    expect(result.success).toBe(true);
    const data = result.data as { filename: string };
    expect(data.filename).toBe("clip.mp4");

    const [row] = testDb.select().from(files).where(eq(files.id, "file-1")).all();
    expect(row.filename).toBe("clip.mp4");
    expect(row.pieceId).toBe("piece-b");

    const moved = await fakeStorage.read("piece-b", "clip.mp4");
    expect(moved.equals(bytes)).toBe(true);
  });
});
