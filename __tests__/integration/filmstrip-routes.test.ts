/**
 * Integration: filmstrip serve + status(+ensure) routes.
 *
 * - GET /filmstrip → 404 before ready, 200 + image/jpeg after ready.
 * - GET /filmstrip-status → JSON status snapshot.
 * - GET /filmstrip-status?ensure=1 (and POST) → enqueues generation when the
 *   sprite is idle/failed; leaves generating/ready alone.
 *
 * The enqueue helper is mocked so the routes are tested without spawning
 * ffmpeg.
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

const enqueueMock = vi.fn();
vi.mock("@/lib/filmstrip/enqueue", () => ({
  enqueueFilmstripGen: (...args: unknown[]) => enqueueMock(...args),
}));

import { GET as serveGET } from "@/app/api/files/by-id/[fileId]/filmstrip/route";
import {
  GET as statusGET,
  POST as statusPOST,
} from "@/app/api/files/by-id/[fileId]/filmstrip-status/route";

const PIECE = "p1";
const FID = "f1";

function insertFile(overrides: Record<string, unknown> = {}) {
  testDb
    .insert(files)
    .values({
      id: FID,
      pieceId: PIECE,
      filename: "clip.mp4",
      name: "clip",
      description: "",
      type: "video",
      storagePath: `${PIECE}/clip.mp4`,
      contentType: "video/mp4",
      size: 5,
      ...overrides,
    })
    .run();
}

describe("filmstrip routes", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
    enqueueMock.mockReset();
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("serve: 404 when status !== ready", async () => {
    insertFile({ filmstripStatus: "generating" });
    const res = await serveGET(
      new Request("http://localhost/api/files/by-id/f1/filmstrip"),
      { params: Promise.resolve({ fileId: FID }) },
    );
    expect(res.status).toBe(404);
  });

  it("serve: 200 + image/jpeg when ready", async () => {
    const pdir = path.join(tempDir, PIECE);
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, "clip-filmstrip.jpg"), Buffer.from("JPGBYTES"));
    insertFile({
      filmstripFilename: "clip-filmstrip.jpg",
      filmstripStatus: "ready",
      filmstripFrames: 20,
      filmstripHeight: 48,
    });

    const res = await serveGET(
      new Request("http://localhost/api/files/by-id/f1/filmstrip"),
      { params: Promise.resolve({ fileId: FID }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(body)).toBe("JPGBYTES");
  });

  it("serve: a sprite whose name contains `...` is served (T1, 2026-09-25)", async () => {
    const name = "Morning_vibe_happyhippie_...-filmstrip.jpg";
    const pdir = path.join(tempDir, PIECE);
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, name), Buffer.from("JPGBYTES"));
    insertFile({ filmstripFilename: name, filmstripStatus: "ready", filmstripFrames: 20, filmstripHeight: 48 });
    const res = await serveGET(
      new Request("http://localhost/api/files/by-id/f1/filmstrip"),
      { params: Promise.resolve({ fileId: FID }) },
    );
    expect(res.status).toBe(200);
  });

  it("serve: a sprite whose name contains a literal `%` is served (fix round 1)", async () => {
    const name = "100%-filmstrip.jpg";
    const pdir = path.join(tempDir, PIECE);
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, name), Buffer.from("JPGBYTES"));
    insertFile({ filmstripFilename: name, filmstripStatus: "ready", filmstripFrames: 20, filmstripHeight: 48 });
    const res = await serveGET(
      new Request("http://localhost/api/files/by-id/f1/filmstrip"),
      { params: Promise.resolve({ fileId: FID }) },
    );
    expect(res.status).toBe(200);
  });

  it("serve: a traversal-shaped sprite name is refused", async () => {
    insertFile({ filmstripFilename: "../x-filmstrip.jpg", filmstripStatus: "ready", filmstripFrames: 20, filmstripHeight: 48 });
    const res = await serveGET(
      new Request("http://localhost/api/files/by-id/f1/filmstrip"),
      { params: Promise.resolve({ fileId: FID }) },
    );
    expect(res.status).toBe(400);
  });

  it("status: returns JSON snapshot of the filmstrip columns", async () => {
    insertFile({
      filmstripFilename: "clip-filmstrip.jpg",
      filmstripStatus: "ready",
      filmstripFrames: 20,
      filmstripHeight: 48,
      filmstripGeneratedAt: new Date("2026-06-20T10:00:00.000Z"),
    });
    const res = await statusGET(
      new Request("http://localhost/api/files/by-id/f1/filmstrip-status"),
      { params: Promise.resolve({ fileId: FID }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      status: "ready",
      filename: "clip-filmstrip.jpg",
      frames: 20,
      height: 48,
      generatedAt: "2026-06-20T10:00:00.000Z",
    });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("status?ensure=1: enqueues when idle", async () => {
    insertFile({ filmstripStatus: "idle" });
    const res = await statusGET(
      new Request("http://localhost/api/files/by-id/f1/filmstrip-status?ensure=1"),
      { params: Promise.resolve({ fileId: FID }) },
    );
    expect(res.status).toBe(200);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(FID, {
      pieceId: PIECE,
      regenerate: false,
    });
  });

  it("status?ensure=1: re-enqueues (regenerate) when failed", async () => {
    insertFile({ filmstripStatus: "failed" });
    await statusGET(
      new Request("http://localhost/api/files/by-id/f1/filmstrip-status?ensure=1"),
      { params: Promise.resolve({ fileId: FID }) },
    );
    expect(enqueueMock).toHaveBeenCalledWith(FID, {
      pieceId: PIECE,
      regenerate: true,
    });
  });

  it("status?ensure=1: leaves a ready/generating sprite alone", async () => {
    insertFile({ filmstripStatus: "ready", filmstripFilename: "clip-filmstrip.jpg" });
    await statusGET(
      new Request("http://localhost/api/files/by-id/f1/filmstrip-status?ensure=1"),
      { params: Promise.resolve({ fileId: FID }) },
    );
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("POST status: enqueues when idle", async () => {
    insertFile({ filmstripStatus: "idle" });
    const res = await statusPOST(
      new Request("http://localhost/api/files/by-id/f1/filmstrip-status", { method: "POST" }),
      { params: Promise.resolve({ fileId: FID }) },
    );
    expect(res.status).toBe(200);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("status: 404 for an unknown file", async () => {
    const res = await statusGET(
      new Request("http://localhost/api/files/by-id/nope/filmstrip-status"),
      { params: Promise.resolve({ fileId: "nope" }) },
    );
    expect(res.status).toBe(404);
  });

  // F14 (final review): a sprite that resolves outside the piece folder is a 404, never a throw.
  it("serve: 404 when the sprite resolves outside the piece folder", async () => {
    const pdir = path.join(tempDir, PIECE);
    fs.mkdirSync(pdir, { recursive: true });
    const outside = path.join(tempDir, "outside-secret.jpg");
    fs.writeFileSync(outside, "SECRET");
    fs.symlinkSync(outside, path.join(pdir, "clip-filmstrip.jpg"));
    insertFile({ filmstripFilename: "clip-filmstrip.jpg", filmstripStatus: "ready" });

    const res = await serveGET(new Request("http://localhost/api/files/by-id/f1/filmstrip"), { params: Promise.resolve({ fileId: FID }) });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain(tempDir);
  });
});
