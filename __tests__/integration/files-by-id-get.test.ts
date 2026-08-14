/**
 * Integration: GET /api/files/by-id/[fileId]
 *
 * The chat thumbnail chip looks up the live file record by id to render
 * the right thumbnail kind, resolve `pieceId` for click-to-open, and
 * detect deleted files. Used to be 405 — now returns the file or 404.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

import { GET } from "@/app/api/files/by-id/[fileId]/route";

const PIECE_ID = "piece-1";
const FILE_ID = "file-abc";

function req(): Request {
  return new Request(`http://localhost/api/files/by-id/${FILE_ID}`);
}

describe("GET /api/files/by-id/[fileId]", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE_ID, name: "P" });
  });

  it("returns the file record when it exists", async () => {
    testDb
      .insert(files)
      .values({
        id: FILE_ID,
        pieceId: PIECE_ID,
        filename: "clip.mp4",
        name: "Clip",
        description: "",
        type: "video",
        storagePath: `${PIECE_ID}/clip.mp4`,
        contentType: "video/mp4",
        size: 1234,
        hasAudio: true,
      })
      .run();

    const res = await GET(req(), { params: Promise.resolve({ fileId: FILE_ID }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.file).toMatchObject({
      id: FILE_ID,
      pieceId: PIECE_ID,
      filename: "clip.mp4",
      type: "video",
      hasAudio: true,
    });
  });

  it("returns 404 when the file no longer exists", async () => {
    const res = await GET(req(), {
      params: Promise.resolve({ fileId: "nonexistent" }),
    });
    expect(res.status).toBe(404);
  });

  it("works for global (no pieceId) files too", async () => {
    testDb
      .insert(files)
      .values({
        id: FILE_ID,
        pieceId: null,
        filename: "song.mp3",
        name: "Song",
        description: "",
        type: "audio",
        storagePath: `_global/song.mp3`,
        contentType: "audio/mpeg",
        size: 100,
      })
      .run();

    const res = await GET(req(), { params: Promise.resolve({ fileId: FILE_ID }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.file.pieceId).toBeNull();
    expect(data.file.type).toBe("audio");
  });
});
