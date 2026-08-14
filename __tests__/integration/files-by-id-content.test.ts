/**
 * Integration: GET /api/files/by-id/[fileId]/content
 *
 * Looks up a file by DB id, reads its bytes from storage, returns them
 * with the right MIME type. This is the URL the preview player uses
 * for video scenes — keyed by id so renames don't break playback.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { files } from "@/lib/db/schema/sqlite";
import fs from "fs";
import path from "path";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({
  getDb: () => testDb,
}));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

// Import AFTER mocks so the route sees them.
import { GET } from "@/app/api/files/by-id/[fileId]/content/route";

const PIECE_ID = "piece-1";
const FILE_ID = "file-abc";

function req(): Request {
  return new Request(`http://localhost/api/files/by-id/${FILE_ID}/content`);
}

describe("GET /api/files/by-id/[fileId]/content", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE_ID, name: "P" });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it("serves a piece-scoped file by id with correct MIME", async () => {
    const pieceDir = path.join(tempDir, PIECE_ID);
    fs.mkdirSync(pieceDir, { recursive: true });
    fs.writeFileSync(path.join(pieceDir, "clip.mp4"), Buffer.from("VIDEO-BYTES"));

    testDb
      .insert(files)
      .values({
        id: FILE_ID,
        pieceId: PIECE_ID,
        filename: "clip.mp4",
        name: "clip",
        description: "",
        type: "video",
        storagePath: `${PIECE_ID}/clip.mp4`,
        contentType: "video/mp4",
        size: 11,
      })
      .run();

    const res = await GET(req(), { params: Promise.resolve({ fileId: FILE_ID }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect(res.headers.get("Content-Length")).toBe("11");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(body)).toBe("VIDEO-BYTES");
  });

  it("returns 404 when the id is unknown", async () => {
    const res = await GET(req(), { params: Promise.resolve({ fileId: "nope" }) });
    expect(res.status).toBe(404);
  });
});
