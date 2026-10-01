/**
 * Integration: each MCP audio tool reads a fixture manifest, applies
 * the change, and writes it back. Uses a temp piece dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema";

let storageRoot: string;
let pieceDir: string;
const PIECE_ID = "p_test";
const FILE_ID = "f_test";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/mcp/tools/social-http", () => ({ api }));

// Mock storage to use the temp dir
vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(join(storageRoot, "storage"));
  },
}));

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "libi-audio-tools-"));
  pieceDir = join(storageRoot, "storage", PIECE_ID);
  mkdirSync(pieceDir, { recursive: true });
  api.mockReset().mockResolvedValue({ ok: true, body: { skipped: "social_not_connected", summary: [] } });
});

afterEach(() => {
  rmSync(storageRoot, { recursive: true, force: true });
});

const ctx = () => ({ pieceId: PIECE_ID });

const writeManifest = (m: object) =>
  writeFileSync(join(pieceDir, "composition.json"), JSON.stringify(m), "utf-8");

const readManifest = () =>
  JSON.parse(readFileSync(join(pieceDir, "composition.json"), "utf-8"));

const baseManifest = {
  width: 1920,
  height: 1080,
  fps: 30,
  audioClips: [] as unknown[],
};

import {
  audioAddClip,
  audioUpdateClip,
  audioRemoveClip,
  audioUnlink,
  audioSplit,
} from "@/mcp/tools/audio-clip-tools";

describe("audio clip MCP tools", () => {
  it("audio_add_clip writes a new clip to the manifest", async () => {
    // Seed a piece + file record so audioAddClip can find it
    const db = createTestDb();
    seedPiece(db, { id: PIECE_ID, name: "Test" });
    db.insert(files).values({
      id: FILE_ID,
      pieceId: PIECE_ID,
      filename: "track.mp3",
      name: "Track",
      description: "",
      type: "audio",
      storagePath: `${PIECE_ID}/track.mp3`,
      size: 0,
      mediaDuration: 5,
    }).run();

    writeManifest(baseManifest);
    const result = await audioAddClip(ctx(), {
      pieceId: PIECE_ID,
      fileId: FILE_ID,
      kind: "standalone",
      startTime: 1,
      duration: 5,
      trimStart: 0,
      volume: 0.9,
      enabled: true,
    });
    expect(result.success).toBe(true);
    expect(readManifest().audioClips).toHaveLength(1);
  });

  it("audio_update_clip patches an existing clip", async () => {
    writeManifest({
      ...baseManifest,
      audioClips: [{ id: "c1", kind: "standalone", fileId: FILE_ID, startTime: 0, duration: 5, trimStart: 0, volume: 1, enabled: true }],
    });
    const result = await audioUpdateClip(ctx(), { pieceId: PIECE_ID, clipId: "c1", volume: 0.3 });
    expect(result.success).toBe(true);
    expect(readManifest().audioClips[0].volume).toBe(0.3);
  });

  it("audio_remove_clip drops a clip", async () => {
    writeManifest({
      ...baseManifest,
      audioClips: [{ id: "c1", kind: "standalone", fileId: FILE_ID, startTime: 0, duration: 5, trimStart: 0, volume: 1, enabled: true }],
    });
    const result = await audioRemoveClip(ctx(), { pieceId: PIECE_ID, clipId: "c1" });
    expect(result.success).toBe(true);
    expect(readManifest().audioClips).toHaveLength(0);
  });

  it("audio_unlink turns an inline clip into standalone", async () => {
    writeManifest({
      ...baseManifest,
      audioClips: [{ id: "c1", kind: "inline", linkedOverlayId: "vid-1", fileId: FILE_ID, startTime: 0, duration: 5, trimStart: 0, volume: 1, enabled: true }],
    });
    const result = await audioUnlink(ctx(), { pieceId: PIECE_ID, clipId: "c1" });
    expect(result.success).toBe(true);
    const clip = readManifest().audioClips[0];
    expect(clip.kind).toBe("standalone");
    // Detaching KEEPS linkedOverlayId — a detached clip still remembers its
    // source video so the timeline can park it there and offer re-attach.
    expect(clip.linkedOverlayId).toBe("vid-1");
  });

  it("audio_split splits a clip in two", async () => {
    writeManifest({
      ...baseManifest,
      audioClips: [{ id: "c1", kind: "standalone", fileId: FILE_ID, startTime: 0, duration: 10, trimStart: 0, volume: 1, enabled: true }],
    });
    const result = await audioSplit(ctx(), { pieceId: PIECE_ID, clipId: "c1", time: 4 });
    expect(result.success).toBe(true);
    expect(readManifest().audioClips).toHaveLength(2);
  });

  it("audio_add_clip reports the file's rights and the copyrighted note", async () => {
    const db = createTestDb();
    seedPiece(db, { id: PIECE_ID, name: "Test" });
    db.insert(files).values({ id: FILE_ID, pieceId: PIECE_ID, filename: "track.mp3", name: "Track", description: "", type: "audio", storagePath: `${PIECE_ID}/track.mp3`, mediaDuration: 3, hasAudio: true, audioRights: JSON.stringify({ class: "copyrighted", decidedBy: "provenance", decidedAt: "2026-09-27T00:00:00.000Z" }) }).run();
    writeManifest(baseManifest);
    const r = await audioAddClip(ctx(), { pieceId: PIECE_ID, fileId: FILE_ID, kind: "standalone", startTime: 0 } as never);
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({
      rights: { class: "copyrighted" },
      note: "left out of social exports by default; at posting each platform gets its own treatment",
    });
  });

  // Owner decision 2026-09-28: an unstamped file is the user's own upload.
  it("audio_add_clip reports an unstamped file as owned, with no copyrighted note", async () => {
    const db = createTestDb();
    seedPiece(db, { id: PIECE_ID, name: "Test" });
    db.insert(files).values({ id: FILE_ID, pieceId: PIECE_ID, filename: "track.mp3", name: "Track", description: "", type: "audio", storagePath: `${PIECE_ID}/track.mp3`, mediaDuration: 3, hasAudio: true }).run();
    writeManifest(baseManifest);
    const r = await audioAddClip(ctx(), { pieceId: PIECE_ID, fileId: FILE_ID, kind: "standalone", startTime: 0 } as never);
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ rights: { class: "owned" } });
    expect((r.data as { note?: string }).note).toBeUndefined();
  });

  const seedSong = (audioRights: string | null = null) => {
    const db = createTestDb();
    seedPiece(db, { id: PIECE_ID, name: "Test" });
    db.insert(files).values({ id: FILE_ID, pieceId: PIECE_ID, filename: "track.mp3", name: "Track", description: "", type: "audio", storagePath: `${PIECE_ID}/track.mp3`, mediaDuration: 3, hasAudio: true, audioRights }).run();
    writeManifest(baseManifest);
    api.mockReset();
  };
  const MATCH = { platforms: { tiktok: { status: "picked", accountId: "tt", track: { id: "tt-1", title: "Espresso", artist: "Sabrina Carpenter" } } }, summary: ["Matched on TikTok: *Espresso — Sabrina Carpenter*."] };

  it("audio_add_clip with rights stamps the song as the agent, adds the clip, and relays the match", async () => {
    seedSong();
    api.mockResolvedValue({ ok: true, body: MATCH });
    const r = await audioAddClip(ctx(), { pieceId: PIECE_ID, fileId: FILE_ID, kind: "standalone", startTime: 0, rights: { class: "copyrighted", track: { title: "Espresso", artist: "Sabrina Carpenter" } } } as never);
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ rights: { class: "copyrighted", track: { title: "Espresso", artist: "Sabrina Carpenter" } }, music: MATCH });
    expect(api).toHaveBeenCalledWith(`/api/files/by-id/${FILE_ID}/music-match`, { method: "POST" });
    expect(readManifest().audioClips).toHaveLength(1);
  });

  it("generated rights stamp without a match", async () => {
    seedSong();
    const r = await audioAddClip(ctx(), { pieceId: PIECE_ID, fileId: FILE_ID, kind: "standalone", startTime: 0, rights: { class: "generated" } } as never);
    expect(r.data).toMatchObject({ rights: { class: "generated" } });
    expect((r.data as { music?: unknown }).music).toBeUndefined();
    expect(api).not.toHaveBeenCalled();
  });

  it("a class the user decided is refused, and nothing is added", async () => {
    seedSong(JSON.stringify({ class: "generated", decidedBy: "user", decidedAt: "x" }));
    const r = await audioAddClip(ctx(), { pieceId: PIECE_ID, fileId: FILE_ID, kind: "standalone", startTime: 0, rights: { class: "copyrighted" } } as never);
    expect(r).toMatchObject({ success: false, error: "user_decided" });
    expect(readManifest().audioClips).toHaveLength(0);
  });

  it("a match that can't run never fails the clip add", async () => {
    seedSong();
    api.mockResolvedValue({ ok: false, status: 0, body: { message: "ECONNREFUSED" } });
    const r = await audioAddClip(ctx(), { pieceId: PIECE_ID, fileId: FILE_ID, kind: "standalone", startTime: 0, rights: { class: "copyrighted", track: { title: "Espresso", artist: "Sabrina Carpenter" } } } as never);
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ music: { error: "libi_server_unavailable", summary: ["libi couldn't match the song on the platforms right now — the user can pick a track when posting."] } });
  });

  it("an already-matched copyrighted song added again is not matched again", async () => {
    seedSong(JSON.stringify({ class: "copyrighted", track: { title: "Espresso", artist: "Sabrina Carpenter" }, decidedBy: "agent", decidedAt: "x", platformPicks: { tiktok: { status: "not_found", decidedBy: "auto", decidedAt: "x" } } }));
    await audioAddClip(ctx(), { pieceId: PIECE_ID, fileId: FILE_ID, kind: "standalone", startTime: 0 } as never);
    expect(api).not.toHaveBeenCalled();
  });

  it("the length gate refuses before anything is stamped", async () => {
    seedSong();
    writeManifest({ ...baseManifest, audioClips: [{ id: "c0", kind: "standalone", fileId: FILE_ID, startTime: 0, duration: 1, trimStart: 0, volume: 1, enabled: true }] });
    const r = await audioAddClip(ctx(), { pieceId: PIECE_ID, fileId: FILE_ID, kind: "standalone", startTime: 0, rights: { class: "copyrighted" } } as never);
    expect(r).toMatchObject({ success: false, error: "asset_longer_than_piece" });
    const { getDb } = await import("@/lib/db/client");
    const { eq } = await import("drizzle-orm");
    expect(getDb().select().from(files).where(eq(files.id, FILE_ID)).get()!.audioRights).toBeNull();
  });

  it("audioAddClipSchema refuses owned", async () => {
    const { audioAddClipSchema } = await import("@/mcp/tools/schemas");
    expect(audioAddClipSchema.safeParse({ pieceId: "p", fileId: "f", startTime: 0, rights: { class: "owned" } }).success).toBe(false);
  });

});

