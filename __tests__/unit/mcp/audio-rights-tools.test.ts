import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { setAudioRights } from "@/mcp/tools/audio-rights-tools";
import { effectiveRights } from "@/lib/audio-rights/read";
import { serializeAudioRights, type AudioRights } from "@/lib/audio-rights/types";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/mcp/tools/social-http", () => ({ api }));

function stamp(r: AudioRights) {
  getDb().update(files).set({ audioRights: serializeAudioRights(r) }).where(eq(files.id, "f1")).run();
}
const rowRights = () => effectiveRights(getDb().select().from(files).where(eq(files.id, "f1")).get()!);

beforeEach(() => {
  const db = createTestDb();
  seedPiece(db);
  db.insert(files).values({ id: "f1", pieceId: "test-piece-1", filename: "a.mp3", name: "a", description: "", type: "audio", storagePath: "test-piece-1/a.mp3", hasAudio: true }).run();
  api.mockReset().mockResolvedValue({ ok: false, status: 0, body: {} });
});
afterEach(() => resetTestDb());

describe("libi.set_audio_rights", () => {
  it("records a confirmed song identity", async () => {
    stamp({ class: "copyrighted", source: { url: "https://youtu.be/x" }, decidedBy: "provenance", decidedAt: "x" });
    const r = await setAudioRights({ pieceId: "test-piece-1", fileId: "f1", track: { title: "Espresso", artist: "Sabrina Carpenter" } });
    expect(r.success).toBe(true);
    const row = getDb().select().from(files).where(eq(files.id, "f1")).get()!;
    expect(effectiveRights(row)).toMatchObject({ class: "copyrighted", track: { title: "Espresso" }, decidedBy: "agent" });
  });

  // Owner decision 2026-09-28: an unstamped upload is the user's own. Naming
  // its song keeps it theirs — and an agent is never the decider of `owned`.
  it("naming the song on an unstamped upload keeps it owned, still decided by provenance", async () => {
    expect((await setAudioRights({ pieceId: "test-piece-1", fileId: "f1", track: { title: "My Demo" } })).success).toBe(true);
    expect(rowRights()).toMatchObject({ class: "owned", track: { title: "My Demo" }, decidedBy: "provenance" });
  });

  it("may re-class the user's unstamped upload as copyrighted (the restrictive direction)", async () => {
    expect((await setAudioRights({ pieceId: "test-piece-1", fileId: "f1", class: "copyrighted" })).success).toBe(true);
    expect(rowRights()).toMatchObject({ class: "copyrighted", decidedBy: "agent" });
  });

  it("may stamp generated", async () => {
    expect((await setAudioRights({ pieceId: "test-piece-1", fileId: "f1", class: "generated" })).success).toBe(true);
  });

  it("refuses owned with the user-only sentence, and writes nothing", async () => {
    const r = await setAudioRights({ pieceId: "test-piece-1", fileId: "f1", class: "owned" });
    expect(r).toEqual({
      success: false,
      error: "owned_user_only",
      data: { hint: "only the user can mark a track as their own — ask them to use the file's details panel" },
    });
    expect(getDb().select().from(files).where(eq(files.id, "f1")).get()!.audioRights).toBeNull();
  });

  it("refuses a file of another piece", async () => {
    const r = await setAudioRights({ pieceId: "other", fileId: "f1", class: "generated" });
    expect(r).toMatchObject({ success: false, error: "file_not_found" });
  });

  it("a track edit merges into the known track: album and isrc survive unless given", async () => {
    stamp({ class: "copyrighted", track: { title: "Espresso", artist: "Sabrina", album: "Short n' Sweet", isrc: "USUM72401994", trackConfidence: "low" }, decidedBy: "provenance", decidedAt: "x" });
    expect((await setAudioRights({ pieceId: "test-piece-1", fileId: "f1", track: { title: "Espresso", artist: "Sabrina Carpenter" } })).success).toBe(true);
    expect(rowRights()?.track).toEqual({ title: "Espresso", artist: "Sabrina Carpenter", album: "Short n' Sweet", isrc: "USUM72401994" });
    await setAudioRights({ pieceId: "test-piece-1", fileId: "f1", track: { title: "Espresso", album: "Espresso (single)" } });
    expect(rowRights()?.track).toMatchObject({ artist: "Sabrina Carpenter", album: "Espresso (single)", isrc: "USUM72401994" });
  });

  it("may not change the class the USER decided; a track edit keeps the user's decision", async () => {
    stamp({ class: "generated", decidedBy: "user", decidedAt: "x" });
    const r = await setAudioRights({ pieceId: "test-piece-1", fileId: "f1", class: "copyrighted" });
    expect(r).toMatchObject({ success: false, error: "user_decided", data: { hint: expect.stringMatching(/the user set this file's rights/) } });
    expect(rowRights()).toMatchObject({ class: "generated", decidedBy: "user" });
    // Naming the track is still fine, and does not make the class the agent's to change.
    expect((await setAudioRights({ pieceId: "test-piece-1", fileId: "f1", track: { title: "My beat" } })).success).toBe(true);
    expect(rowRights()).toMatchObject({ class: "generated", decidedBy: "user", track: { title: "My beat" } });
    expect((await setAudioRights({ pieceId: "test-piece-1", fileId: "f1", class: "copyrighted" })).success).toBe(false);
  });
});

describe("libi.set_audio_rights — a changed song is matched again", () => {
  it("a new identity on a copyrighted song runs the match and relays it", async () => {
    stamp({ class: "copyrighted", decidedBy: "provenance", decidedAt: "x" });
    api.mockReset().mockResolvedValue({ ok: true, body: { skipped: "social_not_connected", summary: ["Social posting isn't connected in libi, so the song wasn't matched on any platform."] } });
    const r = await setAudioRights({ pieceId: "test-piece-1", fileId: "f1", track: { title: "Espresso", artist: "Sabrina Carpenter" } });
    expect(api).toHaveBeenCalledWith("/api/files/by-id/f1/music-match", { method: "POST" });
    expect(r.data).toMatchObject({ music: { skipped: "social_not_connected" } });
  });

  it("a class-only change does not", async () => {
    stamp({ class: "copyrighted", track: { title: "Espresso", artist: "Sabrina Carpenter" }, decidedBy: "provenance", decidedAt: "x" });
    api.mockReset();
    await setAudioRights({ pieceId: "test-piece-1", fileId: "f1", class: "generated" });
    expect(api).not.toHaveBeenCalled();
  });
});
