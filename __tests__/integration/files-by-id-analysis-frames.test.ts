/**
 * Integration: GET /api/files/by-id/[fileId]/analysis/frames/[name]
 *
 * This route does NOT go through lib/storage/local.ts (it builds the path
 * directly from getFramesDir()), so it needs its own realpath-containment
 * re-check — see lib/storage/local.ts's `realPathForRead` doc comment for
 * why a lexical resolve()+startsWith()/basename() check alone is not enough
 * against a symlink planted inside the served directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { files } from "@/lib/db/schema/sqlite";
import { getFramesDir } from "@/lib/analysis/storage";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({
  getDb: () => testDb,
}));

// Import AFTER the mock so the route sees it.
import { GET } from "@/app/api/files/by-id/[fileId]/analysis/frames/[name]/route";

const PIECE_ID = "piece-1";
const FILE_ID = "file-abc";

function req(name: string): Request {
  return new Request(`http://localhost/api/files/by-id/${FILE_ID}/analysis/frames/${name}`);
}

function seedFile(): void {
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
}

describe("GET /api/files/by-id/[fileId]/analysis/frames/[name]", () => {
  beforeEach(() => {
    createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE_ID, name: "P" });
  });

  afterEach(() => {
    cleanupTempDir();
  });

  it("serves a keyframe PNG by name", async () => {
    seedFile();
    const framesDir = getFramesDir(PIECE_ID, FILE_ID);
    fs.mkdirSync(framesDir, { recursive: true });
    fs.writeFileSync(path.join(framesDir, "frame-0001.png"), Buffer.from("PNG-BYTES"));

    const res = await GET(req("frame-0001.png"), {
      params: Promise.resolve({ fileId: FILE_ID, name: "frame-0001.png" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(body)).toBe("PNG-BYTES");
  });

  it("rejects a name that doesn't match the frame-NNNN.png shape", async () => {
    seedFile();
    const res = await GET(req("not-a-frame.png"), {
      params: Promise.resolve({ fileId: FILE_ID, name: "not-a-frame.png" }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses a symlink planted inside the frames dir that points outside it", async () => {
    seedFile();
    const framesDir = getFramesDir(PIECE_ID, FILE_ID);
    fs.mkdirSync(framesDir, { recursive: true });
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-secret-"));
    const secretFile = path.join(secretDir, "id_rsa");
    fs.writeFileSync(secretFile, "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n");
    try {
      // basename()+regex filtering on the request `name` says nothing about
      // what's actually ON DISK at that name — only a realpath re-check
      // catches a symlink already planted there.
      fs.symlinkSync(secretFile, path.join(framesDir, "frame-0001.png"));

      const res = await GET(req("frame-0001.png"), {
        params: Promise.resolve({ fileId: FILE_ID, name: "frame-0001.png" }),
      });
      expect(res.status).toBe(400);
    } finally {
      fs.rmSync(secretDir, { recursive: true, force: true });
    }
  });

  it("returns 404 when the file id is unknown", async () => {
    const res = await GET(req("frame-0001.png"), {
      params: Promise.resolve({ fileId: "nope", name: "frame-0001.png" }),
    });
    expect(res.status).toBe(404);
  });
});
