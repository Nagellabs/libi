/**
 * Integration: GET /api/files/[pieceId]/[filename]
 *
 * The by-FILENAME route (the app itself fetches by id) serves the same stored
 * bytes as the by-id content route. Final re-review 1, I1: it derived the type from the NAME (`.svg` →
 * `image/svg+xml`), sent no nosniff, and was not a media path in proxy.ts — so
 * a template's `logo.svg`, or a hosted `x.svg` stored as `image/png`, was a
 * page that ran as libi when navigated to. It now takes the type from the
 * file's ROW and goes through the same serving rule as the by-id route.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { files } from "@/lib/db/schema/sqlite";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({
  getDb: () => testDb,
}));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

import { GET } from "@/app/api/files/[pieceId]/[filename]/route";

const PIECE_ID = "piece-1";

/** Write `bytes` as `filename`; with a `contentType` argument, also a row. */
async function serve(filename: string, contentType?: string | null, bytes = "BYTES"): Promise<Response> {
  const pieceDir = path.join(tempDir, PIECE_ID);
  fs.mkdirSync(pieceDir, { recursive: true });
  fs.writeFileSync(path.join(pieceDir, filename), bytes);
  if (contentType !== undefined) {
    testDb.insert(files).values({
      id: `f-${filename}`, pieceId: PIECE_ID, filename, name: filename, description: "", type: "other",
      storagePath: `${PIECE_ID}/${filename}`, contentType, size: bytes.length,
    }).run();
  }
  const req = new Request(`http://localhost/api/files/${PIECE_ID}/${filename}`);
  return GET(req, { params: Promise.resolve({ pieceId: PIECE_ID, filename }) });
}

describe("GET /api/files/[pieceId]/[filename]", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE_ID, name: "P" });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it("serves allowlisted media inline with nosniff", async () => {
    const res = await serve("clip.mp4", "video/mp4", "VIDEO-BYTES");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Disposition")).toBeNull();
    expect(await res.text()).toBe("VIDEO-BYTES");
  });

  it("gives an SVG the sandbox CSP and nosniff", async () => {
    const res = await serve("logo.svg", "image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>");
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("takes the type from the file's row, not its name: a hosted x.svg stored as image/png is a PNG", async () => {
    const res = await serve("x.svg", "image/png", "<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>");
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("serves a stored text/html as an octet-stream attachment; a fetch() still gets the bytes", async () => {
    const res = await serve("logo.png", "text/html", "<script>alert(1)</script>");
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment/);
    expect(await res.text()).toBe("<script>alert(1)</script>");
  });

  it("a file with no row falls back to its extension, and a non-media one is an attachment", async () => {
    const png = await serve("thumb.png");
    expect(png.headers.get("Content-Type")).toBe("image/png");
    expect(png.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const html = await serve("page.html");
    expect(html.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(html.headers.get("Content-Disposition")).toMatch(/^attachment/);
    const js = await serve("evil.js");
    expect(js.headers.get("Content-Type")).toBe("application/octet-stream");
  });

  it("serves a stored name containing `...` (T1, 2026-09-25)", async () => {
    const res = await serve("Morning_vibe_happyhippie_....mp4", "video/mp4");
    expect(res.status).toBe(200);
  });

  it.each(["100%.png", "50% off.mp4"])("serves the stored name %j — a literal `%` is legal (fix round 1)", async (name) => {
    const res = await serve(name, name.endsWith(".png") ? "image/png" : "video/mp4");
    expect(res.status).toBe(200);
  });

  it.each(["%2e%2e", "..%2fx", "a%5cb", "..%2fx%", "%2e%2e%", "a%5cb%zz"])("refuses the ENCODED traversal %j in the URL param", async (filename) => {
    const res = await GET(new Request("http://localhost/x"), { params: Promise.resolve({ pieceId: PIECE_ID, filename }) });
    expect(res.status).toBe(400);
  });

  it.each(["../x", "..", "a/b", "a\\b"])("refuses the traversal-shaped filename %j", async (filename) => {
    const res = await GET(new Request("http://localhost/x"), { params: Promise.resolve({ pieceId: PIECE_ID, filename }) });
    expect(res.status).toBe(400);
  });

  it("still refuses traversal and answers 404 for a missing file", async () => {
    const bad = await GET(new Request("http://localhost/x"), { params: Promise.resolve({ pieceId: PIECE_ID, filename: "..%2fx" }) });
    expect(bad.status).toBe(400);
    const missing = await GET(new Request("http://localhost/x"), { params: Promise.resolve({ pieceId: PIECE_ID, filename: "nope.png" }) });
    expect(missing.status).toBe(404);
  });

  // F14 (final review): same for the by-filename route.
  it("a serving failure answers a plain 'Not found', never the error text", async () => {
    const pieceDir = path.join(tempDir, PIECE_ID);
    fs.mkdirSync(pieceDir, { recursive: true });
    const outside = path.join(tempDir, "outside-secret.mp4");
    fs.writeFileSync(outside, "SECRET");
    fs.symlinkSync(outside, path.join(pieceDir, "leak.mp4"));
    fs.writeFileSync(path.join(pieceDir, "gone.mp4"), "X");
    const vanished = vi.spyOn(LocalFileStorage.prototype, "realPathForRead").mockImplementationOnce(async () => {
      throw new Error(`ENOENT: no such file or directory, realpath '${path.join(pieceDir, "gone.mp4")}'`);
    });
    const gone = await GET(new Request("http://localhost/x"), { params: Promise.resolve({ pieceId: PIECE_ID, filename: "gone.mp4" }) });
    vanished.mockRestore();
    const leak = await GET(new Request("http://localhost/x"), { params: Promise.resolve({ pieceId: PIECE_ID, filename: "leak.mp4" }) });
    for (const res of [gone, leak]) {
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toBe("Not found");
      expect(text).not.toContain(tempDir);
    }
  });
});
