import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import type { FileStorage } from "@/lib/storage/types";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the route handlers
// ---------------------------------------------------------------------------

let testDb: ReturnType<typeof createTestDb>;

vi.mock("@/lib/db/client", () => ({
  getDb: () => testDb,
}));

const mockStorage: FileStorage = {
  save: vi.fn(),
  read: vi.fn(),
  exists: vi.fn(),
  delete: vi.fn(),
  deletePieceDir: vi.fn(),
  localPath: vi.fn(),
};

vi.mock("@/lib/storage", () => ({
  getStorage: vi.fn(() => Promise.resolve(mockStorage)),
}));

// ---------------------------------------------------------------------------
// Import route handlers AFTER mocks are wired
// ---------------------------------------------------------------------------

import { GET } from "@/app/api/pieces/[pieceId]/files/route";
import { DELETE } from "@/app/api/pieces/[pieceId]/files/[fileId]/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a file record directly via drizzle. Returns the id. */
function insertFile(
  db: ReturnType<typeof createTestDb>,
  overrides: Partial<{
    id: string;
    pieceId: string;
    filename: string;
    name: string;
    description: string;
    type: string;
    storagePath: string;
    size: number;
    createdAt: Date;
  }> = {},
): string {
  const id = overrides.id ?? crypto.randomUUID();
  db.insert(files)
    .values({
      id,
      pieceId: overrides.pieceId ?? "test-piece-1",
      filename: overrides.filename ?? "test.mp3",
      name: overrides.name ?? "Test File",
      description: overrides.description ?? "A test file",
      type: overrides.type ?? "audio/voiceover",
      storagePath: overrides.storagePath ?? `test-piece-1/${overrides.filename ?? "test.mp3"}`,
      size: overrides.size ?? 1024,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    })
    .run();
  return id;
}

// ---------------------------------------------------------------------------
// Tests — GET /api/pieces/[pieceId]/files
// ---------------------------------------------------------------------------

describe("GET /api/pieces/[pieceId]/files", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedPiece(testDb);
    vi.clearAllMocks();
  });

  it("returns an empty array when no files exist for the piece", async () => {
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ pieceId: "test-piece-1" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.files).toEqual([]);
  });

  it("returns files for the correct piece, ordered by createdAt DESC", async () => {
    const olderDate = new Date("2026-01-01T00:00:00Z");
    const newerDate = new Date("2026-01-02T00:00:00Z");

    const olderId = insertFile(testDb, {
      filename: "older.mp3",
      name: "Older File",
      createdAt: olderDate,
    });
    const newerId = insertFile(testDb, {
      filename: "newer.mp3",
      name: "Newer File",
      createdAt: newerDate,
    });

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ pieceId: "test-piece-1" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.files).toHaveLength(2);

    // Newer file should come first (DESC order)
    expect(data.files[0].id).toBe(newerId);
    expect(data.files[1].id).toBe(olderId);
  });

  it("does not return files from other pieces", async () => {
    seedPiece(testDb, { id: "other-piece", name: "Other Piece" });

    const mainFileId = insertFile(testDb, {
      pieceId: "test-piece-1",
      filename: "main.mp3",
      name: "Main File",
    });
    insertFile(testDb, {
      pieceId: "other-piece",
      filename: "other.mp3",
      name: "Other File",
    });

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ pieceId: "test-piece-1" }),
    });

    const data = await response.json();
    expect(data.files).toHaveLength(1);
    expect(data.files[0].id).toBe(mainFileId);
  });
});

// ---------------------------------------------------------------------------
// Tests — DELETE /api/pieces/[pieceId]/files/[fileId]
// ---------------------------------------------------------------------------

describe("DELETE /api/pieces/[pieceId]/files/[fileId]", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedPiece(testDb);
    vi.clearAllMocks();
  });

  it("deletes file record and storage, returns success", async () => {
    vi.mocked(mockStorage.delete).mockResolvedValue(undefined);

    const fileId = insertFile(testDb, { filename: "to-delete.mp3" });

    const response = await DELETE(new Request("http://localhost", { method: "DELETE" }), {
      params: Promise.resolve({ pieceId: "test-piece-1", fileId }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);

    expect(mockStorage.delete).toHaveBeenCalledWith("test-piece-1", "to-delete.mp3");

    const remaining = testDb.select().from(files).where(eq(files.id, fileId)).all();
    expect(remaining).toHaveLength(0);
  });

  it("returns 404 for a non-existent file", async () => {
    const response = await DELETE(new Request("http://localhost", { method: "DELETE" }), {
      params: Promise.resolve({ pieceId: "test-piece-1", fileId: "does-not-exist" }),
    });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe("File not found");
  });

  it("returns 404 if the file belongs to a different piece", async () => {
    seedPiece(testDb, { id: "other-piece", name: "Other Piece" });

    const fileId = insertFile(testDb, {
      pieceId: "other-piece",
      filename: "foreign.mp3",
      name: "Foreign File",
    });

    const response = await DELETE(new Request("http://localhost", { method: "DELETE" }), {
      params: Promise.resolve({ pieceId: "test-piece-1", fileId }),
    });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe("File not found");

    const remaining = testDb.select().from(files).where(eq(files.id, fileId)).all();
    expect(remaining).toHaveLength(1);
  });

  it("still deletes the DB record even if storage.delete throws", async () => {
    vi.mocked(mockStorage.delete).mockRejectedValue(new Error("disk on fire"));

    const fileId = insertFile(testDb, { filename: "stubborn.mp3" });

    const response = await DELETE(new Request("http://localhost", { method: "DELETE" }), {
      params: Promise.resolve({ pieceId: "test-piece-1", fileId }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);

    expect(mockStorage.delete).toHaveBeenCalledWith("test-piece-1", "stubborn.mp3");

    const remaining = testDb.select().from(files).where(eq(files.id, fileId)).all();
    expect(remaining).toHaveLength(0);
  });
});
