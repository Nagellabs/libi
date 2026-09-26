/**
 * Integration: GET /api/files/by-id/[fileId]/proxy
 *
 * Serves the proxy file bytes when `proxyStatus === 'ready'`. Falls back
 * to 404 otherwise (the React Query hook retries).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { files } from "@/lib/db/schema/sqlite";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

import { GET } from "@/app/api/files/by-id/[fileId]/proxy/route";

const PIECE = "p1";
const FID = "f1";

describe("GET /api/files/by-id/[fileId]/proxy", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("serves proxy bytes when status=ready", async () => {
    const pdir = path.join(tempDir, PIECE);
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, "clip-proxy.mp4"), Buffer.from("PROXY"));
    testDb.insert(files).values({
      id: FID, pieceId: PIECE, filename: "clip.mp4", name: "clip",
      description: "", type: "video", storagePath: `${PIECE}/clip.mp4`,
      contentType: "video/mp4", size: 5,
      proxyFilename: "clip-proxy.mp4", proxyStatus: "ready",
    }).run();

    const res = await GET(
      new Request("http://localhost/api/files/by-id/f1/proxy"),
      { params: Promise.resolve({ fileId: FID }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(body)).toBe("PROXY");
  });

  it("returns 404 when proxyStatus !== ready", async () => {
    testDb.insert(files).values({
      id: FID, pieceId: PIECE, filename: "clip.mp4", name: "c", description: "",
      type: "video", storagePath: `${PIECE}/clip.mp4`, contentType: "video/mp4", size: 0,
      proxyFilename: null, proxyStatus: "generating",
    }).run();

    const res = await GET(
      new Request("http://localhost/api/files/by-id/f1/proxy"),
      { params: Promise.resolve({ fileId: FID }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 304 when If-None-Match matches the ETag", async () => {
    const pdir = path.join(tempDir, PIECE);
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, "clip-proxy.mp4"), Buffer.from("PROXY"));
    const generatedAt = new Date(1_700_000_000_000);
    testDb.insert(files).values({
      id: FID, pieceId: PIECE, filename: "clip.mp4", name: "clip",
      description: "", type: "video", storagePath: `${PIECE}/clip.mp4`,
      contentType: "video/mp4", size: 5,
      proxyFilename: "clip-proxy.mp4", proxyStatus: "ready",
      proxyGeneratedAt: generatedAt,
    }).run();

    const etag = `"${generatedAt.getTime()}"`;
    const res = await GET(
      new Request("http://localhost/api/files/by-id/f1/proxy", {
        headers: { "If-None-Match": etag },
      }),
      { params: Promise.resolve({ fileId: FID }) },
    );
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(etag);
  });
  // T1 (2026-09-25): a downloaded TikTok title ending in `...` stored its proxy
  // as `…_...-proxy.mp4`; the old substring guard answered 400 and the editor
  // sat on "Buffering…" forever.
  it("serves a proxy whose name contains `...` (a title ending in dots)", async () => {
    const name = "Morning_vibe_happyhippie_...-proxy.mp4";
    const pdir = path.join(tempDir, PIECE);
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, name), Buffer.from("PROXY"));
    testDb.insert(files).values({
      id: FID, pieceId: PIECE, filename: "Morning_vibe_happyhippie_....mp4", name: "clip",
      description: "", type: "video", storagePath: `${PIECE}/x.mp4`,
      contentType: "video/mp4", size: 5,
      proxyFilename: name, proxyStatus: "ready",
    }).run();
    const res = await GET(
      new Request("http://localhost/api/files/by-id/f1/proxy"),
      { params: Promise.resolve({ fileId: FID }) },
    );
    expect(res.status).toBe(200);
  });

  it("serves a proxy whose name contains a literal `%` (fix round 1)", async () => {
    const name = "50% off-proxy.mp4";
    const pdir = path.join(tempDir, PIECE);
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, name), Buffer.from("PROXY"));
    testDb.insert(files).values({
      id: FID, pieceId: PIECE, filename: "50% off.mp4", name: "clip",
      description: "", type: "video", storagePath: `${PIECE}/x.mp4`,
      contentType: "video/mp4", size: 5,
      proxyFilename: name, proxyStatus: "ready",
    }).run();
    const res = await GET(
      new Request("http://localhost/api/files/by-id/f1/proxy"),
      { params: Promise.resolve({ fileId: FID }) },
    );
    expect(res.status).toBe(200);
  });

  it.each(["../x-proxy.mp4", "..", "a/b-proxy.mp4", "a\\b-proxy.mp4"])(
    "still refuses the traversal-shaped proxy name %j",
    async (proxyFilename) => {
      testDb.insert(files).values({
        id: FID, pieceId: PIECE, filename: "clip.mp4", name: "clip",
        description: "", type: "video", storagePath: `${PIECE}/clip.mp4`,
        contentType: "video/mp4", size: 5, proxyFilename, proxyStatus: "ready",
      }).run();
      const res = await GET(
        new Request("http://localhost/api/files/by-id/f1/proxy"),
        { params: Promise.resolve({ fileId: FID }) },
      );
      expect(res.status).toBe(400);
    },
  );

  // F14 (final review): a proxy that resolves outside the piece folder (a planted symlink) is a
  // 404, never an unhandled throw (a 500 carrying the resolved path).
  it("answers 404 when the proxy resolves outside the piece folder", async () => {
    const pdir = path.join(tempDir, PIECE);
    fs.mkdirSync(pdir, { recursive: true });
    const outside = path.join(tempDir, "outside-secret.mp4");
    fs.writeFileSync(outside, "SECRET");
    fs.symlinkSync(outside, path.join(pdir, "clip-proxy.mp4"));
    testDb.insert(files).values({
      id: FID, pieceId: PIECE, filename: "clip.mp4", name: "clip",
      description: "", type: "video", storagePath: `${PIECE}/clip.mp4`,
      contentType: "video/mp4", size: 5,
      proxyFilename: "clip-proxy.mp4", proxyStatus: "ready",
    }).run();

    const res = await GET(new Request("http://localhost/api/files/by-id/f1/proxy"), { params: Promise.resolve({ fileId: FID }) });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain(tempDir);
  });
});
