import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const logSpies = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() }));
vi.mock("@/lib/logger", () => ({ serverLogger: logSpies, mcpLogger: logSpies }));

import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { effectiveRights } from "@/lib/audio-rights/read";
import { serializeAudioRights, type AudioRights, type PlatformPick } from "@/lib/audio-rights/types";
import { setPlatformPick } from "@/lib/audio-rights/platform-picks";
import { updateAudioRights } from "@/lib/audio-rights/write";

const SONG: AudioRights = { class: "copyrighted", track: { title: "Espresso", artist: "Sabrina Carpenter" }, decidedBy: "provenance", decidedAt: "2026-09-27T00:00:00.000Z" };
const pick = (decidedBy: PlatformPick["decidedBy"], id = "tt-1"): PlatformPick => ({ status: "picked", track: { id, title: "Espresso", artist: "Sabrina Carpenter" }, decidedBy, decidedAt: "2026-09-28T00:00:00.000Z", accountId: "tt" });
const rights = () => effectiveRights(getDb().select().from(files).where(eq(files.id, "f1")).get()!)!;
const stamp = (r: AudioRights) => getDb().update(files).set({ audioRights: serializeAudioRights(r) }).where(eq(files.id, "f1")).run();

beforeEach(() => {
  const db = createTestDb();
  seedPiece(db);
  db.insert(files).values({ id: "f1", pieceId: "test-piece-1", filename: "a.mp3", name: "a", description: "", type: "audio", storagePath: "test-piece-1/a.mp3", hasAudio: true }).run();
  stamp(SONG);
  logSpies.info.mockClear();
});
afterEach(() => resetTestDb());

describe("setPlatformPick", () => {
  it("writes a pick without touching who decided the class, and logs it", () => {
    const r = setPlatformPick("f1", "tiktok", pick("auto"));
    expect(r).toMatchObject({ ok: true, written: true, pieceId: "test-piece-1" });
    expect(rights()).toMatchObject({ class: "copyrighted", decidedBy: "provenance", decidedAt: SONG.decidedAt, platformPicks: { tiktok: pick("auto") } });
    expect(logSpies.info).toHaveBeenCalledWith(expect.objectContaining({ tag: "social-music", op: "platform_pick_set", platform: "tiktok", status: "picked", decidedBy: "auto" }), expect.any(String));
  });

  it("neither the automatic match nor the agent replaces or clears the user's pick", () => {
    setPlatformPick("f1", "tiktok", pick("user", "mine"));
    expect(setPlatformPick("f1", "tiktok", pick("auto"))).toMatchObject({ ok: true, written: false });
    expect(setPlatformPick("f1", "tiktok", pick("agent"))).toMatchObject({ ok: true, written: false });
    expect(setPlatformPick("f1", "tiktok", null, "auto")).toMatchObject({ ok: true, written: false });
    expect(rights().platformPicks?.tiktok?.track?.id).toBe("mine");
    expect(setPlatformPick("f1", "tiktok", null, "user")).toMatchObject({ ok: true, written: true });
    expect(rights().platformPicks).toBeUndefined();
  });

  it("the user replaces an automatic pick", () => {
    setPlatformPick("f1", "tiktok", pick("auto"));
    setPlatformPick("f1", "tiktok", pick("user", "mine"));
    expect(rights().platformPicks?.tiktok).toMatchObject({ decidedBy: "user", track: { id: "mine" } });
  });

  it("only a platform with a catalog holds a pick, and only a draft-handoff platform holds a draft", () => {
    expect(setPlatformPick("f1", "youtube", pick("user"))).toEqual({ ok: false, code: "invalid_pick", message: "YouTube has no music library to pick from." });
    expect(setPlatformPick("f1", "instagram", { status: "draft", decidedBy: "user", decidedAt: "x" })).toEqual({ ok: false, code: "invalid_pick", message: "Instagram has no draft to finish in the app." });
    expect(setPlatformPick("f1", "tiktok", { status: "draft", decidedBy: "user", decidedAt: "x" })).toMatchObject({ ok: true, written: true });
  });

  it("stamps an unstamped upload with its provenance rights plus the pick", () => {
    getDb().update(files).set({ audioRights: null }).where(eq(files.id, "f1")).run();
    expect(setPlatformPick("f1", "tiktok", pick("user"))).toMatchObject({ ok: true, written: true });
    expect(rights()).toMatchObject({ class: "owned", decidedBy: "provenance", platformPicks: { tiktok: { decidedBy: "user" } } });
  });

  it("refuses an unknown file and a file with no audio", () => {
    expect(setPlatformPick("nope", "tiktok", pick("auto"))).toMatchObject({ ok: false, code: "not_found" });
    getDb().insert(files).values({ id: "img", pieceId: "test-piece-1", filename: "p.png", name: "p", description: "", type: "image", storagePath: "test-piece-1/p.png" }).run();
    expect(setPlatformPick("img", "tiktok", pick("auto"))).toMatchObject({ ok: false, code: "no_audio" });
  });
});

describe("updateAudioRights keeps picks honest", () => {
  it("renaming the song drops the automatic and agent picks, keeps the user's, and says the track changed", () => {
    setPlatformPick("f1", "tiktok", pick("user", "mine"));
    setPlatformPick("f1", "instagram", { ...pick("auto", "ig-1") });
    const r = updateAudioRights("f1", { track: { title: "Taste", artist: "Sabrina Carpenter" } }, "agent");
    expect(r).toMatchObject({ ok: true, trackChanged: true });
    expect(rights().platformPicks).toEqual({ tiktok: expect.objectContaining({ decidedBy: "user" }) });
  });

  it("a class change or a same-song edit keeps every pick", () => {
    setPlatformPick("f1", "instagram", pick("auto", "ig-1"));
    expect(updateAudioRights("f1", { track: { title: " espresso ", artist: "SABRINA CARPENTER" } }, "agent")).toMatchObject({ ok: true, trackChanged: false });
    expect(updateAudioRights("f1", { class: "generated" }, "agent")).toMatchObject({ ok: true, trackChanged: false });
    expect(rights().platformPicks?.instagram?.track?.id).toBe("ig-1");
  });
});
