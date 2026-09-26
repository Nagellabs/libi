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

  it("serves an original whose name contains `...` (T1, 2026-09-25)", async () => {
    const res = await serve("Morning_vibe_happyhippie_....mp4", "video/mp4", "VIDEO");
    expect(res.status).toBe(200);
  });

  it.each(["100%.png", "50% off.mp4"])("serves the stored name %j — a literal `%` is legal (fix round 1)", async (name) => {
    const res = await serve(name, name.endsWith(".png") ? "image/png" : "video/mp4", "BYTES");
    expect(res.status).toBe(200);
  });

  // The by-filename route refuses these as a URL segment (Windows hazards). A name read from the
  // DB is the literal on-disk name, so by id they serve — the route any in-app viewer of such a
  // file should use.
  it.each(["shot 12:30.png", "take 1.mp4.", "clip "])("serves the stored name %j by id", async (name) => {
    const res = await serve(name, "image/png", "BYTES");
    expect(res.status).toBe(200);
  });

  it.each(["../x.mp4", "..", "a/b.mp4", "a\\b.mp4"])("refuses the traversal-shaped stored name %j", async (filename) => {
    testDb.insert(files).values({
      id: FILE_ID, pieceId: PIECE_ID, filename, name: "x", description: "", type: "video",
      storagePath: `${PIECE_ID}/x`, contentType: "video/mp4", size: 1,
    }).run();
    const res = await GET(req(), { params: Promise.resolve({ fileId: FILE_ID }) });
    expect(res.status).toBe(400);
  });

  /** Store `bytes` under `filename` with `contentType` and GET it. */
  async function serve(filename: string, contentType: string | null, bytes = "BYTES"): Promise<Response> {
    const pieceDir = path.join(tempDir, PIECE_ID);
    fs.mkdirSync(pieceDir, { recursive: true });
    fs.writeFileSync(path.join(pieceDir, filename), bytes);
    testDb.insert(files).values({
      id: FILE_ID, pieceId: PIECE_ID, filename, name: filename, description: "", type: "other",
      storagePath: `${PIECE_ID}/${filename}`, contentType, size: bytes.length,
    }).run();
    return GET(req(), { params: Promise.resolve({ fileId: FILE_ID }) });
  }

  // Final review I1(b): this route served a row's stored type verbatim, with no
  // nosniff — so a template asset recorded as `text/html` was a page in libi's
  // origin, where libi's CSP allows inline script.
  describe("hardening (final review I1)", () => {
    it("serves allowlisted media inline, always with nosniff", async () => {
      const res = await serve("clip.mp4", "video/mp4");
      expect(res.headers.get("Content-Type")).toBe("video/mp4");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Content-Disposition")).toBeNull();
    });
    it("serves a stored text/html as an octet-stream attachment", async () => {
      const res = await serve("logo.png", "text/html", "<script>alert(1)</script>");
      expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(res.headers.get("Content-Disposition")).toMatch(/^attachment/);
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      // The bytes still reach a fetch() caller (the text viewer reads them so).
      expect(await res.text()).toBe("<script>alert(1)</script>");
    });
    it("an untyped row falls back to its extension, and an unknown one is an attachment", async () => {
      const res = await serve("page.html", null);
      expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(res.headers.get("Content-Disposition")).toMatch(/^attachment/);
    });
    it("gives an SVG the sandbox CSP", async () => {
      const res = await serve("logo.svg", "image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>");
      expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
      expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });
    it("keeps a PDF inline for the asset viewer's <embed>", async () => {
      const res = await serve("doc.pdf", "application/pdf");
      expect(res.headers.get("Content-Type")).toBe("application/pdf");
      expect(res.headers.get("Content-Disposition")).toBeNull();
    });
  });

  // F14 (final review): a failure while serving never sends err.message — fs errors carry the
  // absolute storage path. Two real shapes: a name that resolves out of the piece folder, and the
  // file vanishing between the existence check and the read (fs's ENOENT names the full path).
  it("a serving failure answers a plain 'Not found', never the error text", async () => {
    const pieceDir = path.join(tempDir, PIECE_ID);
    fs.mkdirSync(pieceDir, { recursive: true });
    const outside = path.join(tempDir, "outside-secret.mp4");
    fs.writeFileSync(outside, "SECRET");
    fs.symlinkSync(outside, path.join(pieceDir, "leak.mp4"));
    fs.writeFileSync(path.join(pieceDir, "gone.mp4"), "X");
    for (const [id, filename] of [["f-leak", "leak.mp4"], ["f-gone", "gone.mp4"]]) {
      testDb.insert(files).values({
        id, pieceId: PIECE_ID, filename, name: filename, description: "",
        type: "video", storagePath: `${PIECE_ID}/${filename}`, contentType: "video/mp4", size: 1,
      }).run();
    }
    const vanished = vi.spyOn(LocalFileStorage.prototype, "realPathForRead").mockImplementationOnce(async () => {
      throw new Error(`ENOENT: no such file or directory, realpath '${path.join(pieceDir, "gone.mp4")}'`);
    });
    const gone = await GET(req(), { params: Promise.resolve({ fileId: "f-gone" }) });
    vanished.mockRestore();
    const leak = await GET(req(), { params: Promise.resolve({ fileId: "f-leak" }) });
    for (const res of [gone, leak]) {
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toBe("Not found");
      expect(text).not.toContain(tempDir);
    }
  });
});
