/**
 * `storeFile` must dedupe the filename within a scope. Two uploads of the same
 * name to one piece previously collided on a single physical path: both DB rows
 * pointed at one file, so deleting either unlinked the shared bytes and orphaned
 * the survivor (silent data loss — observed in QA). The second save must land at
 * a distinct name ("x (1).png") and a distinct storage path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";
import type { FileStorage } from "@/lib/storage/types";

vi.mock("@/mcp/jobs-client", () => ({
  enqueueJobOnServer: vi.fn(() =>
    Promise.resolve({ status: "new", jobId: "job-1", clientKey: "ck-1" }),
  ),
  LibiServerUnavailableError: class LibiServerUnavailableError extends Error {},
}));

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

const mockStorage: FileStorage = {
  // Echo back the scope-relative path the way LocalFileStorage does.
  save: vi.fn((pieceId: string | null, filename: string) =>
    Promise.resolve(`${pieceId ?? "_global"}/${filename}`),
  ),
  read: vi.fn(),
  exists: vi.fn(),
  delete: vi.fn(),
  deletePieceDir: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  localPath: vi.fn((pieceId: string | null, filename: string) => `/s/${pieceId}/${filename}`),
};
vi.mock("@/lib/storage", () => ({ getStorage: vi.fn(() => Promise.resolve(mockStorage)) }));

import { storeFile } from "@/mcp/tools/file-tools";

describe("storeFile dedupes filenames within a scope", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedPiece(testDb);
    vi.clearAllMocks();
  });

  it("appends ' (N)' on collision so saved bytes never share a path", async () => {
    const a = await storeFile({
      pieceId: "test-piece-1",
      filename: "ref.png",
      buffer: Buffer.from("a"),
      contentType: "image/png",
    });
    const b = await storeFile({
      pieceId: "test-piece-1",
      filename: "ref.png",
      buffer: Buffer.from("b"),
      contentType: "image/png",
    });
    const c = await storeFile({
      pieceId: "test-piece-1",
      filename: "ref.png",
      buffer: Buffer.from("c"),
      contentType: "image/png",
    });

    expect(a.filename).toBe("ref.png");
    expect(b.filename).toBe("ref (1).png");
    expect(c.filename).toBe("ref (2).png");

    // Distinct storage paths — the core invariant that prevents orphaning.
    const paths = new Set([a.storagePath, b.storagePath, c.storagePath]);
    expect(paths.size).toBe(3);

    const rows = testDb.select().from(files).all();
    const refRows = rows.filter((r) => r.pieceId === "test-piece-1");
    expect(refRows.map((r) => r.filename).sort()).toEqual([
      "ref (1).png",
      "ref (2).png",
      "ref.png",
    ]);
  });

  it("does not dedupe across different scopes", async () => {
    const piece = await storeFile({
      pieceId: "test-piece-1",
      filename: "ref.png",
      buffer: Buffer.from("a"),
      contentType: "image/png",
    });
    const global = await storeFile({
      pieceId: null,
      filename: "ref.png",
      buffer: Buffer.from("b"),
      contentType: "image/png",
    });
    expect(piece.filename).toBe("ref.png");
    expect(global.filename).toBe("ref.png"); // different scope → no collision
  });
});
