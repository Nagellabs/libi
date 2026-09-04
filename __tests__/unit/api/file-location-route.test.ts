import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

// Import the handler AFTER the mock is wired.
import { GET } from "@/app/api/files/by-id/[fileId]/location/route";

let storageDir: string;
let prevStorageDir: string | undefined;

function params(fileId: string) {
  return { params: Promise.resolve({ fileId }) };
}

beforeEach(() => {
  testDb = createTestDb();
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-location-"));
  prevStorageDir = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = storageDir;
});

afterEach(() => {
  if (prevStorageDir === undefined) delete process.env.STORAGE_DIR;
  else process.env.STORAGE_DIR = prevStorageDir;
  fs.rmSync(storageDir, { recursive: true, force: true });
});

function seedFile(opts: { id: string; pieceId: string | null; filename: string }) {
  if (opts.pieceId) {
    seedPiece(testDb, { id: opts.pieceId });
  }
  testDb
    .insert(files)
    .values({
      id: opts.id,
      pieceId: opts.pieceId,
      filename: opts.filename,
      name: opts.filename,
      description: "",
      type: "video",
      storagePath: opts.filename,
      size: 0,
    })
    .run();
}

function writeOnDisk(pieceDir: string, filename: string) {
  const dir = path.join(storageDir, pieceDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), "x");
}

describe("GET /api/files/by-id/[fileId]/location", () => {
  it("returns the absolute path and exists:true for a file on disk", async () => {
    seedFile({ id: "f1", pieceId: "p1", filename: "clip.mp4" });
    writeOnDisk("p1", "clip.mp4");

    const res = await GET(new Request("http://x"), params("f1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.path).toBe(path.join(storageDir, "p1", "clip.mp4"));
  });

  it("returns exists:false when the row is present but the file is gone", async () => {
    seedFile({ id: "f2", pieceId: "p2", filename: "missing.mp4" });

    const res = await GET(new Request("http://x"), params("f2"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exists).toBe(false);
    expect(body.path).toBe(path.join(storageDir, "p2", "missing.mp4"));
  });

  it("resolves a global file (pieceId null) under _global", async () => {
    seedFile({ id: "f3", pieceId: null, filename: "logo.png" });
    writeOnDisk("_global", "logo.png");

    const res = await GET(new Request("http://x"), params("f3"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe(path.join(storageDir, "_global", "logo.png"));
    expect(body.exists).toBe(true);
  });

  it("404s for an unknown file id", async () => {
    const res = await GET(new Request("http://x"), params("nope"));
    expect(res.status).toBe(404);
  });
});
