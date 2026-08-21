/**
 * /api/pieces/{pid}/audio-clips/{cid}/duck — POST enables, PATCH
 * patches, DELETE removes. Real route handlers, real fs-backed
 * manifest, mocked SSE emitter (we only check the data stays correct).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let storageRoot: string;
const PIECE_ID = "p_duck_http";

// Mock storage to use the current temp dir (avoids singleton caching across tests)
vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(join(storageRoot, "storage"));
  },
}));

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "libi-duck-http-"));
  process.env.LIBI_HOME = storageRoot;
  mkdirSync(join(storageRoot, "storage", PIECE_ID), { recursive: true });
  writeFileSync(
    join(storageRoot, "storage", PIECE_ID, "composition.json"),
    JSON.stringify({
      width: 1920, height: 1080, fps: 30,
      audioClips: [
        { id: "music", kind: "standalone", fileId: "fm", startTime: 0, duration: 60, trimStart: 0, volume: 1, enabled: true },
        { id: "vo",    kind: "standalone", fileId: "fv", startTime: 0, duration: 30, trimStart: 0, volume: 1, enabled: true },
        { id: "vo2",   kind: "standalone", fileId: "fv2", startTime: 30, duration: 30, trimStart: 0, volume: 1, enabled: true },
      ],
    }),
  );
});

afterEach(() => {
  delete process.env.LIBI_HOME;
  rmSync(storageRoot, { recursive: true, force: true });
});

const readManifest = () =>
  JSON.parse(readFileSync(join(storageRoot, "storage", PIECE_ID, "composition.json"), "utf-8"));

describe("/duck HTTP routes", () => {
  it("POST enables ducking with overrides", async () => {
    const { POST } = await import(
      "@/app/api/pieces/[pieceId]/audio-clips/[clipId]/duck/route"
    );
    const req = new Request("http://test/api/pieces/p_duck_http/audio-clips/music/duck", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sidechainClipIds: ["vo"], thresholdDb: -25, ratio: 6 }),
    });
    const res = await POST(req, { params: Promise.resolve({ pieceId: PIECE_ID, clipId: "music" }) });
    expect(res.status).toBe(200);
    const m = readManifest();
    expect(m.audioClips.find((c: { id: string }) => c.id === "music").duck).toMatchObject({
      sidechainClipIds: ["vo"], thresholdDb: -25, ratio: 6,
    });
  });

  it("POST returns 400 when ducking a clip against itself", async () => {
    const { POST } = await import("@/app/api/pieces/[pieceId]/audio-clips/[clipId]/duck/route");
    const req = new Request("http://test/api/pieces/p_duck_http/audio-clips/music/duck", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sidechainClipIds: ["music"] }),
    });
    const res = await POST(req, { params: Promise.resolve({ pieceId: PIECE_ID, clipId: "music" }) });
    expect(res.status).toBe(400);
  });

  it("PATCH updates duck params on a clip with ducking already enabled", async () => {
    // Enable first.
    {
      const { POST } = await import("@/app/api/pieces/[pieceId]/audio-clips/[clipId]/duck/route");
      await POST(
        new Request("http://test/x", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sidechainClipIds: ["vo"] }),
        }),
        { params: Promise.resolve({ pieceId: PIECE_ID, clipId: "music" }) },
      );
    }
    const { PATCH } = await import("@/app/api/pieces/[pieceId]/audio-clips/[clipId]/duck/route");
    const res = await PATCH(
      new Request("http://test/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ratio: 8 }),
      }),
      { params: Promise.resolve({ pieceId: PIECE_ID, clipId: "music" }) },
    );
    expect(res.status).toBe(200);
    expect(readManifest().audioClips.find((c: { id: string }) => c.id === "music").duck.ratio).toBe(8);
  });

  it("DELETE removes the duck object", async () => {
    {
      const { POST } = await import("@/app/api/pieces/[pieceId]/audio-clips/[clipId]/duck/route");
      await POST(
        new Request("http://test/x", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sidechainClipIds: ["vo"] }),
        }),
        { params: Promise.resolve({ pieceId: PIECE_ID, clipId: "music" }) },
      );
    }
    const { DELETE } = await import("@/app/api/pieces/[pieceId]/audio-clips/[clipId]/duck/route");
    const res = await DELETE(
      new Request("http://test/x", { method: "DELETE" }),
      { params: Promise.resolve({ pieceId: PIECE_ID, clipId: "music" }) },
    );
    expect(res.status).toBe(200);
    expect(readManifest().audioClips.find((c: { id: string }) => c.id === "music").duck).toBeUndefined();
  });

  it("POST accepts several sidechains — the timeline dialog sends the whole set", async () => {
    const { POST } = await import("@/app/api/pieces/[pieceId]/audio-clips/[clipId]/duck/route");
    const res = await POST(
      new Request("http://test/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sidechainClipIds: ["vo", "vo2"] }),
      }),
      { params: Promise.resolve({ pieceId: PIECE_ID, clipId: "music" }) },
    );
    expect(res.status).toBe(200);
    expect(
      readManifest().audioClips.find((c: { id: string }) => c.id === "music").duck.sidechainClipIds,
    ).toEqual(["vo", "vo2"]);
  });

  it("POST still accepts the deprecated single sidechainClipId", async () => {
    const { POST } = await import("@/app/api/pieces/[pieceId]/audio-clips/[clipId]/duck/route");
    const res = await POST(
      new Request("http://test/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sidechainClipId: "vo" }),
      }),
      { params: Promise.resolve({ pieceId: PIECE_ID, clipId: "music" }) },
    );
    expect(res.status).toBe(200);
    expect(
      readManifest().audioClips.find((c: { id: string }) => c.id === "music").duck.sidechainClipIds,
    ).toEqual(["vo"]);
  });

  it("POST returns 400 when no sidechain is named at all", async () => {
    const { POST } = await import("@/app/api/pieces/[pieceId]/audio-clips/[clipId]/duck/route");
    const res = await POST(
      new Request("http://test/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ pieceId: PIECE_ID, clipId: "music" }) },
    );
    expect(res.status).toBe(400);
  });

  it("PATCH replaces the sidechain set", async () => {
    const { POST, PATCH } = await import("@/app/api/pieces/[pieceId]/audio-clips/[clipId]/duck/route");
    await POST(
      new Request("http://test/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sidechainClipIds: ["vo"] }),
      }),
      { params: Promise.resolve({ pieceId: PIECE_ID, clipId: "music" }) },
    );
    const res = await PATCH(
      new Request("http://test/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sidechainClipIds: ["vo", "vo2"] }),
      }),
      { params: Promise.resolve({ pieceId: PIECE_ID, clipId: "music" }) },
    );
    expect(res.status).toBe(200);
    expect(
      readManifest().audioClips.find((c: { id: string }) => c.id === "music").duck.sidechainClipIds,
    ).toEqual(["vo", "vo2"]);
  });
});
