import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let storageRoot: string;
const PIECE_ID = "p_duck";

// Mock storage singleton so each test gets a fresh LocalFileStorage
// pointing at the current temp dir (avoids caching across tests).
vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(join(storageRoot, "storage"));
  },
}));

import {
  audioDuckEnable,
  audioDuckDisable,
  audioDuckUpdate,
} from "@/mcp/tools/audio-duck-tools";

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "libi-duck-tools-"));
  mkdirSync(join(storageRoot, "storage", PIECE_ID), { recursive: true });
  writeFileSync(
    join(storageRoot, "storage", PIECE_ID, "composition.json"),
    JSON.stringify({
      width: 1920,
      height: 1080,
      fps: 30,
      audioClips: [
        { id: "music", kind: "standalone", fileId: "f-m", startTime: 0, duration: 60, trimStart: 0, volume: 1, enabled: true },
        { id: "vo", kind: "standalone", fileId: "f-vo", startTime: 0, duration: 30, trimStart: 0, volume: 1, enabled: true },
        { id: "vo2", kind: "standalone", fileId: "f-vo2", startTime: 30, duration: 15, trimStart: 0, volume: 1, enabled: true },
        { id: "vo3", kind: "standalone", fileId: "f-vo3", startTime: 45, duration: 15, trimStart: 0, volume: 1, enabled: true },
      ],
    }),
  );
});

afterEach(() => {
  rmSync(storageRoot, { recursive: true, force: true });
});

const readManifest = () =>
  JSON.parse(readFileSync(join(storageRoot, "storage", PIECE_ID, "composition.json"), "utf-8"));

describe("audio_duck_enable", () => {
  it("attaches a duck object with defaults to the target clip", async () => {
    const result = await audioDuckEnable(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music", sidechainClipIds: ["vo"] },
    );
    expect(result.success).toBe(true);
    const music = readManifest().audioClips.find((c: { id: string }) => c.id === "music");
    expect(music.duck).toMatchObject({
      sidechainClipIds: ["vo"],
      thresholdDb: -30,
      ratio: 4,
      attackMs: 50,
      releaseMs: 250,
      reductionDb: -12,
    });
  });

  it("rejects when sidechain clip doesn't exist", async () => {
    const result = await audioDuckEnable(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music", sidechainClipIds: ["nope"] },
    );
    expect(result.success).toBe(false);
  });

  it("rejects when target clip doesn't exist", async () => {
    const result = await audioDuckEnable(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "missing", sidechainClipIds: ["vo"] },
    );
    expect(result.success).toBe(false);
  });

  it("rejects self-ducking (clip cannot duck itself)", async () => {
    const result = await audioDuckEnable(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music", sidechainClipIds: ["music"] },
    );
    expect(result.success).toBe(false);
  });
});

describe("audio_duck_disable", () => {
  it("removes the duck object", async () => {
    await audioDuckEnable(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music", sidechainClipIds: ["vo"] },
    );
    const result = await audioDuckDisable(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music" },
    );
    expect(result.success).toBe(true);
    expect(readManifest().audioClips.find((c: { id: string }) => c.id === "music").duck).toBeUndefined();
  });
});

describe("audio_duck_update", () => {
  it("patches individual duck fields", async () => {
    await audioDuckEnable(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music", sidechainClipIds: ["vo"] },
    );
    const result = await audioDuckUpdate(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music", thresholdDb: -25, ratio: 6 },
    );
    expect(result.success).toBe(true);
    const music = readManifest().audioClips.find((c: { id: string }) => c.id === "music");
    expect(music.duck.thresholdDb).toBe(-25);
    expect(music.duck.ratio).toBe(6);
    expect(music.duck.releaseMs).toBe(250); // unchanged
  });

  it("rejects when ducking isn't enabled on the clip", async () => {
    const result = await audioDuckUpdate(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music", thresholdDb: -25 },
    );
    expect(result.success).toBe(false);
  });
});

describe("audio_duck_disable idempotency + edge cases", () => {
  it("disabling a clip with no ducking is a no-op success", async () => {
    const result = await audioDuckDisable(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music" },
    );
    // Existing implementation should treat a missing-duck disable as a no-op
    // success rather than an error — the user's intent is "no ducking on
    // this clip" and that's already true.
    expect(result.success).toBe(true);
  });

  it("disabling a missing clip fails with an explicit error", async () => {
    const result = await audioDuckDisable(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "nope" },
    );
    expect(result.success).toBe(false);
  });
});

describe("audio_duck_update edge cases", () => {
  it("updating with no fields returns the existing duck unchanged", async () => {
    await audioDuckEnable(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music", sidechainClipIds: ["vo"] },
    );
    const before = readManifest().audioClips.find((c: { id: string }) => c.id === "music").duck;
    const result = await audioDuckUpdate(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music" },
    );
    expect(result.success).toBe(true);
    const after = readManifest().audioClips.find((c: { id: string }) => c.id === "music").duck;
    expect(after).toEqual(before);
  });

  it("clamps out-of-range params (ratio = 100 → 20)", async () => {
    await audioDuckEnable(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music", sidechainClipIds: ["vo"] },
    );
    const result = await audioDuckUpdate(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music", ratio: 100 },
    );
    // sanitizeDuck clamps ratio to max 20; success with clamped value.
    expect(result.success).toBe(true);
    expect(readManifest().audioClips.find((c: { id: string }) => c.id === "music").duck.ratio).toBe(20);
  });
});

/**
 * A duck takes ANY number of sidechains. Before that, a piece with six VO lines
 * had to be ffmpeg'd into one 42-second "VO bus" clip and re-rendered on every
 * retime. The single-id form stays accepted so older skills keep working.
 */
describe("audio_duck_enable — multiple sidechains", () => {
  const readDuck = () =>
    readManifest().audioClips.find((c: { id: string }) => c.id === "music").duck;

  it("stores every sidechain clip", async () => {
    const result = await audioDuckEnable(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music", sidechainClipIds: ["vo", "vo2", "vo3"] },
    );
    expect(result.success).toBe(true);
    expect(readDuck().sidechainClipIds).toEqual(["vo", "vo2", "vo3"]);
  });

  it("accepts the deprecated single sidechainClipId and writes an array", async () => {
    const result = await audioDuckEnable(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music", sidechainClipId: "vo" },
    );
    expect(result.success).toBe(true);
    expect(readDuck().sidechainClipIds).toEqual(["vo"]);
    expect(readDuck().sidechainClipId).toBeUndefined();
  });

  it("rejects when ANY of the sidechains is missing", async () => {
    const result = await audioDuckEnable(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music", sidechainClipIds: ["vo", "ghost"] },
    );
    expect(result.success).toBe(false);
  });

  it("rejects a self-duck hidden among several sidechains", async () => {
    const result = await audioDuckEnable(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music", sidechainClipIds: ["vo", "music"] },
    );
    expect(result.success).toBe(false);
  });

  it("audio_duck_update replaces the whole sidechain set", async () => {
    await audioDuckEnable(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music", sidechainClipIds: ["vo"] },
    );
    const result = await audioDuckUpdate(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music", sidechainClipIds: ["vo2", "vo3"] },
    );
    expect(result.success).toBe(true);
    expect(readDuck().sidechainClipIds).toEqual(["vo2", "vo3"]);
  });

  it("audio_duck_update leaves the sidechain set alone when patching other params", async () => {
    await audioDuckEnable(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music", sidechainClipIds: ["vo", "vo2"] },
    );
    await audioDuckUpdate({ pieceId: PIECE_ID }, { pieceId: PIECE_ID, clipId: "music", ratio: 8 });
    expect(readDuck().sidechainClipIds).toEqual(["vo", "vo2"]);
    expect(readDuck().ratio).toBe(8);
  });

  it("audio_duck_update rejects a sidechain set that would form a cycle", async () => {
    await audioDuckEnable(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music", sidechainClipIds: ["vo"] },
    );
    await audioDuckEnable(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "vo2", sidechainClipIds: ["music"] },
    );
    const result = await audioDuckUpdate(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music", sidechainClipIds: ["vo", "vo2"] },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cycle/i);
  });
});

describe("legacy manifests", () => {
  it("normalizes a stored sidechainClipId to an array on load, without a migration", async () => {
    // Exactly what is on disk for every piece ducked before 2026-08-18.
    const manifest = readManifest();
    manifest.audioClips.find((c: { id: string }) => c.id === "music").duck = {
      sidechainClipId: "vo",
      thresholdDb: -30, ratio: 4, attackMs: 50, releaseMs: 250, reductionDb: -12,
    };
    writeFileSync(
      join(storageRoot, "storage", PIECE_ID, "composition.json"),
      JSON.stringify(manifest),
    );

    // Any tool call round-trips the manifest through loadManifest/saveManifest.
    const result = await audioDuckUpdate(
      { pieceId: PIECE_ID },
      { pieceId: PIECE_ID, clipId: "music", ratio: 6 },
    );
    expect(result.success).toBe(true);
    const duck = readManifest().audioClips.find((c: { id: string }) => c.id === "music").duck;
    expect(duck.sidechainClipIds).toEqual(["vo"]);
    expect(duck.sidechainClipId).toBeUndefined();
    expect(duck.ratio).toBe(6);
    expect(duck.releaseMs).toBe(250); // the rest of the duck survives untouched
  });
});
