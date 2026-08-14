/**
 * HTTP routes for audio clips — round-trip add → update → split → delete
 * via real fetch through the route handlers. Uses the runtime's actual
 * Request/Response objects so schema validation and error shapes are
 * covered end to end.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { files, pieces } from "@/lib/db/schema";

let storageRoot: string;
const PIECE_ID = "p_http";

// Mock storage to use the current temp dir (avoids singleton caching across tests)
vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(join(storageRoot, "storage"));
  },
}));

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "libi-http-clips-"));
  process.env.LIBI_HOME = storageRoot;
  mkdirSync(join(storageRoot, "storage", PIECE_ID), { recursive: true });
  writeFileSync(
    join(storageRoot, "storage", PIECE_ID, "composition.json"),
    JSON.stringify({ sceneOrder: [], width: 1920, height: 1080, fps: 30, audioClips: [] }),
  );

  const db = createTestDb();
  db.insert(pieces).values({ id: PIECE_ID, name: "p", description: "", nameSetByUser: false }).run();
  db.insert(files).values({
    id: "f1", pieceId: PIECE_ID, filename: "music.mp3", name: "music.mp3", description: "",
    type: "audio", storagePath: "test", size: 0, mediaDuration: 30, hasAudio: true,
  }).run();
});

afterEach(() => {
  delete process.env.LIBI_HOME;
  resetTestDb();
  rmSync(storageRoot, { recursive: true, force: true });
});

const readManifest = () =>
  JSON.parse(readFileSync(join(storageRoot, "storage", PIECE_ID, "composition.json"), "utf-8"));

describe("audio clip HTTP routes", () => {
  it("POST /api/pieces/{pid}/audio-clips creates a clip", async () => {
    const { POST } = await import(
      "@/app/api/pieces/[pieceId]/audio-clips/route"
    );
    const req = new Request("http://test/api/pieces/p_http/audio-clips", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileId: "f1", kind: "standalone", startTime: 0, duration: 30 }),
    });
    const res = await POST(req, { params: Promise.resolve({ pieceId: PIECE_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clipId).toMatch(/^clip_/);
    expect(readManifest().audioClips).toHaveLength(1);
  });

  it("POST returns 400 for invalid params", async () => {
    const { POST } = await import("@/app/api/pieces/[pieceId]/audio-clips/route");
    const req = new Request("http://test/api/pieces/p_http/audio-clips", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileId: "f1", startTime: -5 }),  // negative startTime
    });
    const res = await POST(req, { params: Promise.resolve({ pieceId: PIECE_ID }) });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/pieces/{pid}/audio-clips/{cid} updates fields", async () => {
    writeFileSync(
      join(storageRoot, "storage", PIECE_ID, "composition.json"),
      JSON.stringify({
        sceneOrder: [], width: 1920, height: 1080, fps: 30,
        audioClips: [{ id: "c1", kind: "standalone", fileId: "f1", startTime: 0, duration: 5, trimStart: 0, volume: 1, enabled: true }],
      }),
    );
    const { PATCH } = await import(
      "@/app/api/pieces/[pieceId]/audio-clips/[clipId]/route"
    );
    const req = new Request("http://test/api/pieces/p_http/audio-clips/c1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ volume: 0.3, enabled: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ pieceId: PIECE_ID, clipId: "c1" }) });
    expect(res.status).toBe(200);
    const m = readManifest();
    expect(m.audioClips[0].volume).toBe(0.3);
    expect(m.audioClips[0].enabled).toBe(false);
  });

  it("PATCH returns 400 for unknown clipId", async () => {
    const { PATCH } = await import("@/app/api/pieces/[pieceId]/audio-clips/[clipId]/route");
    const req = new Request("http://test/api/pieces/p_http/audio-clips/missing", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ volume: 0.5 }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ pieceId: PIECE_ID, clipId: "missing" }) });
    expect(res.status).toBe(400);
  });

  it("DELETE removes a clip", async () => {
    writeFileSync(
      join(storageRoot, "storage", PIECE_ID, "composition.json"),
      JSON.stringify({
        sceneOrder: [], width: 1920, height: 1080, fps: 30,
        audioClips: [{ id: "c1", kind: "standalone", fileId: "f1", startTime: 0, duration: 5, trimStart: 0, volume: 1, enabled: true }],
      }),
    );
    const { DELETE } = await import("@/app/api/pieces/[pieceId]/audio-clips/[clipId]/route");
    const req = new Request("http://test/api/pieces/p_http/audio-clips/c1", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ pieceId: PIECE_ID, clipId: "c1" }) });
    expect(res.status).toBe(200);
    expect(readManifest().audioClips).toHaveLength(0);
  });

  it("POST /split splits a clip", async () => {
    writeFileSync(
      join(storageRoot, "storage", PIECE_ID, "composition.json"),
      JSON.stringify({
        sceneOrder: [], width: 1920, height: 1080, fps: 30,
        audioClips: [{ id: "c1", kind: "standalone", fileId: "f1", startTime: 0, duration: 10, trimStart: 0, volume: 1, enabled: true }],
      }),
    );
    const { POST } = await import("@/app/api/pieces/[pieceId]/audio-clips/[clipId]/split/route");
    const req = new Request("http://test/api/pieces/p_http/audio-clips/c1/split", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ time: 4 }),
    });
    const res = await POST(req, { params: Promise.resolve({ pieceId: PIECE_ID, clipId: "c1" }) });
    expect(res.status).toBe(200);
    expect(readManifest().audioClips).toHaveLength(2);
  });
});
