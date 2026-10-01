/** Matching through a PROVIDER-NEUTRAL fake adapter: nothing here knows any provider. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const logSpies = vi.hoisted(() => {
  const s = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn() };
  s.child.mockImplementation(() => s);
  return s;
});
vi.mock("@/lib/logger", () => ({ serverLogger: logSpies, mcpLogger: logSpies }));

import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { __setSocialServiceForTests } from "@/lib/social/service";
import { effectiveRights } from "@/lib/audio-rights/read";
import { serializeAudioRights, type AudioRights } from "@/lib/audio-rights/types";
import { describeMatch, matchSongOnPlatforms } from "@/lib/social/music-match";
import type { SocialAdapter } from "@/lib/social/adapter";
import { SocialError } from "@/lib/social/errors";
import * as platformPicks from "@/lib/audio-rights/platform-picks";

let connected = true;
let accounts: Array<{ id: string; platform: string; active: boolean; username: string; displayName: string }> = [];
const catalog = vi.fn();
const facts = vi.fn();
const BIZ = { tiktokKind: { value: "business", source: "detected", checkedAt: "t" } };
const FB = { instagramFacebookLogin: { value: true, source: "detected", checkedAt: "t" } };
const TT_ESPRESSO = { id: "tt-1", title: "Espresso", artist: "Sabrina Carpenter", durationSec: 175, kind: "trending", rank: 3 };
const SONG: AudioRights = { class: "copyrighted", track: { title: "Espresso", artist: "Sabrina Carpenter" }, decidedBy: "agent", decidedAt: "x" };

function install() {
  const adapter = { providerId: "acme", listAccounts: async () => accounts, musicAccountFacts: facts, musicCatalog: catalog };
  __setSocialServiceForTests({
    async status() { return { providerId: "acme" as never, connected, needsReconnect: false, scopes: [] }; },
    async adapter() { return adapter as unknown as SocialAdapter; },
    markUnauthorized() {}, reset() {}, disconnect() {},
  });
}
const stamp = (r: AudioRights) => getDb().update(files).set({ audioRights: serializeAudioRights(r) }).where(eq(files.id, "s")).run();
const picks = () => effectiveRights(getDb().select().from(files).where(eq(files.id, "s")).get()!)?.platformPicks;

beforeEach(() => {
  createTestDb();
  seedPiece(getDb() as never, { id: "p1" });
  getDb().insert(files).values({ id: "s", pieceId: "p1", filename: "s.mp3", name: "s.mp3", description: "", type: "audio", storagePath: "p1/s.mp3", hasAudio: true }).run();
  stamp(SONG);
  connected = true;
  accounts = [
    { id: "tt", platform: "tiktok", active: true, username: "u", displayName: "U" },
    { id: "ig", platform: "instagram", active: true, username: "u", displayName: "U" },
    { id: "yt", platform: "youtube", active: true, username: "u", displayName: "U" },
  ];
  facts.mockReset().mockImplementation(async (_id: string, platform: string) => (platform === "tiktok" ? BIZ : FB));
  catalog.mockReset().mockImplementation(async (_id: string, q: { platform: string }) => ({ tracks: q.platform === "tiktok" ? [TT_ESPRESSO] : [] }));
  install();
});
afterEach(() => {
  __setSocialServiceForTests(null);
  resetTestDb();
});

describe("matchSongOnPlatforms", () => {
  it("matches on every attach-capable platform and writes automatic picks; a platform with no catalog is not asked", async () => {
    const r = await matchSongOnPlatforms("s", { now: () => new Date("2026-09-28T00:00:00.000Z") });
    expect(r).toEqual({
      platforms: {
        tiktok: { status: "picked", accountId: "tt", track: { id: "tt-1", title: "Espresso", artist: "Sabrina Carpenter", durationSec: 175 } },
        instagram: { status: "not_found", accountId: "ig", fallback: "strip" },
      },
      summary: [
        "Matched on TikTok: *Espresso — Sabrina Carpenter*.",
        "Not in Instagram's results — it'll be left out there unless the user picks a track.",
      ],
    });
    expect(catalog).toHaveBeenCalledWith("tt", { platform: "tiktok" });
    expect(catalog).toHaveBeenCalledWith("ig", { platform: "instagram", query: "Espresso Sabrina Carpenter" });
    expect(catalog).not.toHaveBeenCalledWith("yt", expect.anything());
    expect(picks()).toEqual({
      tiktok: { status: "picked", track: { id: "tt-1", title: "Espresso", artist: "Sabrina Carpenter", durationSec: 175 }, decidedBy: "auto", decidedAt: "2026-09-28T00:00:00.000Z", providerId: "acme", accountId: "tt" },
      instagram: { status: "not_found", decidedBy: "auto", decidedAt: "2026-09-28T00:00:00.000Z", providerId: "acme", accountId: "ig" },
    });
  });

  it("an account that cannot attach is reported, and nothing is written for it", async () => {
    facts.mockImplementation(async (_id: string, platform: string) => (platform === "tiktok" ? BIZ : { instagramFacebookLogin: { value: false, source: "detected", checkedAt: "t" } }));
    const r = await matchSongOnPlatforms("s");
    expect("platforms" in r && r.platforms.instagram).toEqual({ status: "cannot_attach", accountId: "ig", reason: "needs_facebook_login" });
    expect(catalog).not.toHaveBeenCalledWith("ig", expect.anything());
    expect(picks()?.instagram).toBeUndefined();
    expect(r.summary).toContain("Instagram can't attach licensed music on this account: it needs Facebook Login — reconnect the account choosing Facebook.");
  });

  it("a platform where the user picked is skipped, and says so", async () => {
    stamp({ ...SONG, platformPicks: { tiktok: { status: "draft", decidedBy: "user", decidedAt: "x" } } });
    const r = await matchSongOnPlatforms("s");
    expect("platforms" in r && r.platforms.tiktok).toEqual({ status: "kept_user_pick", pick: { status: "draft", decidedBy: "user", decidedAt: "x" } });
    expect(catalog).not.toHaveBeenCalledWith("tt", expect.anything());
    expect(r.summary).toContain("TikTok: the user chose to finish in the TikTok app.");
  });

  it("the whole call is bounded: a slow platform reports a timeout and a late answer writes nothing", async () => {
    let release!: (v: unknown) => void;
    catalog.mockImplementation((_id: string, q: { platform: string }) =>
      q.platform === "instagram" ? new Promise((res) => { release = res; }) : Promise.resolve({ tracks: [TT_ESPRESSO] }),
    );
    const r = await matchSongOnPlatforms("s", { budgetMs: 50 });
    expect(r).toMatchObject({ incomplete: "timeout", platforms: { tiktok: { status: "picked" }, instagram: { status: "error", accountId: "ig", reason: "timeout" } } });
    release({ tracks: [{ id: "ig-1", title: "Espresso", artist: "Sabrina Carpenter", kind: "search" }] });
    await new Promise((res) => setTimeout(res, 20));
    expect(picks()?.instagram).toBeUndefined();
  });

  it("one platform's provider error never costs the other", async () => {
    catalog.mockImplementation(async (_id: string, q: { platform: string }) => {
      if (q.platform === "instagram") throw new Error("upstream 502");
      return { tracks: [TT_ESPRESSO] };
    });
    const r = await matchSongOnPlatforms("s");
    expect(r).toMatchObject({ platforms: { tiktok: { status: "picked" }, instagram: { status: "error", accountId: "ig", reason: "provider_error" } } });
  });

  it("a rename mid-match is never attached to the old song's track", async () => {
    catalog.mockImplementation(async (_id: string, q: { platform: string }) => {
      if (q.platform === "tiktok") {
        // The song is renamed while this platform's catalog call is in flight
        // (still `await`ing here) — before the answer is used to write a pick.
        stamp({ class: "copyrighted", track: { title: "Different Song", artist: "Someone Else" }, decidedBy: "agent", decidedAt: "y" });
        return { tracks: [TT_ESPRESSO] };
      }
      return { tracks: [] };
    });
    const r = await matchSongOnPlatforms("s");
    expect("platforms" in r && r.platforms.tiktok).toEqual({ status: "error", accountId: "tt", reason: "song_changed" });
    expect(picks()?.tiktok).toBeUndefined();
  });

  it("a write that fails is reported as an error, never picked", async () => {
    const spy = vi.spyOn(platformPicks, "setPlatformPick").mockReturnValueOnce({ ok: false, code: "not_found", message: "File not found: s" });
    const r = await matchSongOnPlatforms("s");
    expect("platforms" in r && r.platforms.tiktok).toEqual({ status: "error", accountId: "tt", reason: "provider_error" });
    expect(picks()?.tiktok).toBeUndefined();
    spy.mockRestore();
  });

  it("a revoked grant stops every other still-running platform from writing, and is reported as such", async () => {
    let release!: (v: unknown) => void;
    catalog.mockImplementation((_id: string, q: { platform: string }) =>
      q.platform === "tiktok" ? Promise.reject(new SocialError("unauthorized", "revoked")) : new Promise((res) => { release = res; }),
    );
    const r = await matchSongOnPlatforms("s");
    expect(r).toMatchObject({ incomplete: "unauthorized", platforms: {} });
    release({ tracks: [{ id: "ig-1", title: "Espresso", artist: "Sabrina Carpenter", kind: "search" }] });
    await new Promise((res) => setTimeout(res, 20));
    expect(picks()?.instagram).toBeUndefined();
  });

  it("a platform stuck probing account facts is timed out too, and its catalog is never called", async () => {
    facts.mockImplementation((_id: string, platform: string) => (platform === "tiktok" ? Promise.resolve(BIZ) : new Promise(() => {})));
    const r = await matchSongOnPlatforms("s", { budgetMs: 50 });
    expect(r).toMatchObject({ incomplete: "timeout", platforms: { tiktok: { status: "picked" }, instagram: { status: "error", accountId: "ig", reason: "timeout" } } });
    expect(catalog).not.toHaveBeenCalledWith("ig", expect.anything());
  });

  it("skips without asking the provider when the song can't be matched or social isn't connected", async () => {
    connected = false;
    expect(await matchSongOnPlatforms("s")).toMatchObject({ skipped: "social_not_connected" });
    connected = true;
    stamp({ ...SONG, track: { title: "Espresso" } });
    expect(await matchSongOnPlatforms("s")).toMatchObject({ skipped: "no_song_identity" });
    stamp({ ...SONG, track: { title: "Espresso", artist: "Sabrina Carpenter", trackConfidence: "low" } });
    expect(await matchSongOnPlatforms("s")).toMatchObject({ skipped: "identity_unconfirmed" });
    stamp({ ...SONG, class: "generated" });
    expect(await matchSongOnPlatforms("s")).toMatchObject({ skipped: "not_copyrighted" });
    expect(await matchSongOnPlatforms("nope")).toMatchObject({ skipped: "file_not_found" });
    expect(catalog).not.toHaveBeenCalled();
  });
});

describe("describeMatch", () => {
  it("speaks per platform, from the rules", () => {
    expect(describeMatch({ platforms: { tiktok: { status: "not_found", accountId: "tt", fallback: "draft" } } })).toEqual([
      "Not in TikTok's trending list — the TikTok post goes as a draft to finish in the app unless the user picks a track.",
    ]);
    expect(describeMatch({ platforms: {}, incomplete: "timeout" })).toEqual(["The social provider didn't answer in time; nothing was matched."]);
    expect(describeMatch({ skipped: "social_not_connected" })).toEqual(["Social posting isn't connected in libi, so the song wasn't matched on any platform."]);
  });

  it("a call that stopped short says so even when other platforms produced lines (M1)", () => {
    const track = { id: "tt-1", title: "Espresso", artist: "Sabrina Carpenter" };
    expect(describeMatch({ platforms: { tiktok: { status: "picked", accountId: "tt", track } }, incomplete: "timeout" })).toEqual([
      "Matched on TikTok: *Espresso — Sabrina Carpenter*.",
      "The social provider didn't answer in time; the rest wasn't matched — match the song again later.",
    ]);
    expect(describeMatch({ platforms: { tiktok: { status: "picked", accountId: "tt", track } }, incomplete: "unauthorized" }).at(-1)).toBe(
      "Libi's connection to social posting was revoked — ask the user to reconnect it, then match the song again.",
    );
  });

  it("a revoked grant tells the agent to reconnect, not that nothing answered", () => {
    expect(describeMatch({ platforms: {}, incomplete: "unauthorized" })).toEqual([
      "Libi's connection to social posting was revoked — ask the user to reconnect it, then match the song again.",
    ]);
  });

  it("names a platform whose song changed mid-match, distinctly from a timeout", () => {
    expect(describeMatch({ platforms: { tiktok: { status: "error", accountId: "tt", reason: "song_changed" } } })).toEqual([
      "The song changed while TikTok was still looking — matching it again will pick up the new one.",
    ]);
  });
});
