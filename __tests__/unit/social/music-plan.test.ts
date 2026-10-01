/**
 * `planPieceMusic` — the one service the composer, the Posting tab and the
 * agent's `libi.social_music_search` ask for a piece's music plan per target:
 * the piece's audio + the account's facts + (when attach is on the table) the
 * platform catalog → `resolveMusicPlan`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";

// `child` answers the same spies: the manifest persistence logs through a child logger.
const logSpies = vi.hoisted(() => {
  const s = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn() };
  s.child.mockImplementation(() => s);
  return s;
});
vi.mock("@/lib/logger", () => ({ serverLogger: logSpies, mcpLogger: logSpies }));

import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { setSocialSettings } from "@/lib/db/settings";
import { loadManifest, saveManifest } from "@/lib/composition/persistence";
import { __setSocialServiceForTests } from "@/lib/social/service";
import { serializeAudioRights } from "@/lib/audio-rights/types";
import { planPieceMusic } from "@/lib/social/music-plan";
import type { SocialAdapter } from "@/lib/social/adapter";

const catalog = vi.fn();
const getCatalogTrack = vi.fn();
function service() {
  const adapter = {
    musicAccountFacts: async (_id: string, platform: string) =>
      platform === "tiktok"
        ? { tiktokKind: { value: "business", source: "detected", checkedAt: "t" } }
        : { instagramFacebookLogin: { value: true, source: "detected", checkedAt: "t" } },
    musicCatalog: catalog,
    getCatalogTrack,
  };
  __setSocialServiceForTests({
    async status() {
      return { providerId: "zernio" as const, connected: true, needsReconnect: false, scopes: [] };
    },
    async adapter() {
      return adapter as unknown as SocialAdapter;
    },
    markUnauthorized() {},
    reset() {},
    disconnect() {},
  });
}

beforeEach(async () => {
  createTestDb();
  createTempStorageDir();
  seedPiece(getDb() as never, { id: "p1" });
  setSocialSettings({ providerId: "zernio", timezone: null, defaults: { instagramType: "reel", aiLabel: true }, pollSeconds: 30 });
  getDb()
    .insert(files)
    .values({
      id: "s",
      pieceId: "p1",
      filename: "s.mp3",
      name: "s.mp3",
      description: "",
      type: "audio",
      storagePath: "p1/s.mp3",
      hasAudio: true,
      audioRights: serializeAudioRights({ class: "copyrighted", track: { title: "Espresso", artist: "Sabrina Carpenter" }, decidedBy: "agent", decidedAt: "x" }),
    })
    .run();
  const m = await loadManifest("p1");
  m.audioClips = [{ id: "c", kind: "standalone", fileId: "s", startTime: 0, duration: 10, trimStart: 0, volume: 1, enabled: true }];
  await saveManifest("p1", m);
  catalog.mockReset();
  getCatalogTrack.mockReset();
  for (const spy of Object.values(logSpies)) spy.mockClear();
  service();
});
afterEach(() => {
  __setSocialServiceForTests(null);
  resetTestDb();
  cleanupTempDir();
});

describe("planPieceMusic", () => {
  it("resolves every target, matching against the catalog it fetched", async () => {
    catalog.mockImplementation(async (_id: string, q: { platform: string; query?: string }) => ({
      tracks: [{ id: q.platform === "tiktok" ? "tt-1" : "ig-1", title: "Espresso", artist: "Sabrina Carpenter", kind: q.query ? "search" : "trending" }],
    }));
    const r = await planPieceMusic("p1", [{ platform: "instagram", accountId: "ig" }, { platform: "tiktok", accountId: "tt" }, { platform: "youtube" }]);
    expect(r.copyrighted).toBe(true);
    expect(r.hasMusic).toBe(true);
    expect(r.targets.map((t) => [t.platform, t.plan.mode, t.plan.exportVariant])).toEqual([
      ["instagram", "attach", "without-song"],
      ["tiktok", "attach", "without-song"],
      ["youtube", "include", "with-song"],
    ]);
    expect(catalog).toHaveBeenCalledWith("ig", { platform: "instagram", query: "Espresso Sabrina Carpenter" });
    expect(catalog).toHaveBeenCalledWith("tt", { platform: "tiktok" });
    expect(catalog).toHaveBeenCalledTimes(2);
    expect(r.targets[0].music).toMatchObject({ mode: "attach", track: { id: "ig-1" } });
    expect(r.variants["without-song"]).toEqual({ purpose: "social", excludedFileIds: ["s"], carriesCopyrighted: false });
    expect(r.variants["with-song"]).toEqual({ purpose: "social", excludedFileIds: [], carriesCopyrighted: true });
    expect(logSpies.info).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "social-music", op: "plan_resolved", platform: "youtube", mode: "include", needsChoice: false }),
      expect.any(String),
    );
  });

  it("honours a requested mode and a picked track id", async () => {
    catalog.mockResolvedValue({ tracks: [{ id: "tt-9", title: "Self Aware", artist: "Mark Allan Wolfe", kind: "trending" }] });
    const r = await planPieceMusic("p1", [{ platform: "tiktok", accountId: "tt", music: { mode: "attach", trackId: "tt-9" } }]);
    expect(r.targets[0].music).toMatchObject({ mode: "attach", track: { id: "tt-9" } });
  });

  it("looks up a picked Instagram track the search didn't return", async () => {
    catalog.mockResolvedValue({ tracks: [] });
    getCatalogTrack.mockResolvedValue({ id: "ig-7", title: "Please Please Please", artist: "Sabrina Carpenter", kind: "search" });
    const r = await planPieceMusic("p1", [{ platform: "instagram", accountId: "ig", music: { mode: "attach", trackId: "ig-7" } }]);
    expect(getCatalogTrack).toHaveBeenCalledWith("ig", "ig-7");
    expect(r.targets[0].music).toMatchObject({ mode: "attach", track: { id: "ig-7" } });
  });

  it("an unavailable catalog falls back with a warning", async () => {
    catalog.mockResolvedValue({ unavailable: { reason: "error" } });
    const r = await planPieceMusic("p1", [{ platform: "tiktok", accountId: "tt" }]);
    expect(r.targets[0].plan.mode).toBe("draft");
    expect(r.targets[0].plan.warnings[0]).toMatch(/couldn't be read/);
  });

  it("asks no catalog when the requested mode is not attach", async () => {
    const r = await planPieceMusic("p1", [{ platform: "tiktok", accountId: "tt", music: { mode: "strip" } }]);
    expect(catalog).not.toHaveBeenCalled();
    expect(r.targets[0].plan.mode).toBe("strip");
    expect(r.targets[0].music).toEqual({ mode: "strip" });
  });
  it("a song only on a hidden layer is not planned (the export never plays it)", async () => {
    getDb().insert(files).values({ id: "v", pieceId: "p1", filename: "v.mp4", name: "Clip", description: "", type: "video", storagePath: "p1/v.mp4", hasAudio: true }).run();
    const m = await loadManifest("p1");
    m.overlays = [
      { id: "vid", kind: "video", fileId: "v", z: 0, startTime: 0, duration: 10, trimStart: 0, rect: { x: 0, y: 0, width: 1080, height: 1920 }, hidden: true },
    ] as unknown as typeof m.overlays;
    // The only song is the hidden video's own sound.
    m.audioClips = [{ id: "c", kind: "inline", linkedOverlayId: "vid", fileId: "v", startTime: 0, duration: 10, trimStart: 0, volume: 1, enabled: true }];
    await saveManifest("p1", m);
    const r = await planPieceMusic("p1", [{ platform: "tiktok", accountId: "tt" }]);
    expect(r.copyrighted).toBe(false);
    expect(r.hasMusic).toBe(false);
    expect(catalog).not.toHaveBeenCalled();
    expect(r.variants["without-song"].excludedFileIds).toEqual([]);
  });

  const storePick = (platform: "tiktok" | "instagram", id: string) =>
    getDb()
      .update(files)
      .set({
        audioRights: serializeAudioRights({
          class: "copyrighted", track: { title: "Espresso", artist: "Sabrina Carpenter" }, decidedBy: "agent", decidedAt: "x",
          platformPicks: { [platform]: { status: "picked", track: { id, title: "Self Aware", artist: "Mark Allan Wolfe" }, decidedBy: "user", decidedAt: "x" } },
        }),
      })
      .where(eq(files.id, "s"))
      .run();

  it("a stored pick on a SEARCH platform is used as-is: no catalog read", async () => {
    storePick("instagram", "ig-9");
    const r = await planPieceMusic("p1", [{ platform: "instagram", accountId: "ig" }]);
    expect(catalog).not.toHaveBeenCalled();
    expect(r.targets[0].plan).toMatchObject({ mode: "attach", track: { id: "ig-9" }, trackSource: "user" });
  });

  it("a stored pick on a TRENDING platform is checked against today's list — one read, no query (I2)", async () => {
    storePick("tiktok", "tt-9");
    catalog.mockResolvedValue({ tracks: [{ id: "tt-9", title: "Self Aware", artist: "Mark Allan Wolfe", kind: "trending" }] });
    const r = await planPieceMusic("p1", [{ platform: "tiktok", accountId: "tt" }]);
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(catalog).toHaveBeenCalledWith("tt", { platform: "tiktok" });
    expect(r.targets[0].plan).toMatchObject({ mode: "attach", track: { id: "tt-9" }, trackSource: "user" });
  });

  it("a stored TikTok pick that left the trending list → the draft fallback, saying it's no longer in the top 100 (I2)", async () => {
    storePick("tiktok", "tt-9");
    catalog.mockResolvedValue({ tracks: [{ id: "tt-1", title: "Espresso", artist: "Sabrina Carpenter", kind: "trending" }] });
    const r = await planPieceMusic("p1", [{ platform: "tiktok", accountId: "tt" }]);
    expect(r.targets[0].plan.mode).toBe("draft");
    expect(r.targets[0].plan.warnings[0]).toContain("is no longer in TikTok's top 100");
    expect(r.targets[0].music).toEqual({ mode: "draft" });
  });

  it("the search query comes from the platform rules: a search platform searches the song, a trending one takes none", async () => {
    catalog.mockResolvedValue({ tracks: [] });
    await planPieceMusic("p1", [{ platform: "instagram", accountId: "ig" }, { platform: "tiktok", accountId: "tt" }]);
    expect(catalog).toHaveBeenCalledWith("ig", { platform: "instagram", query: "Espresso Sabrina Carpenter" });
    expect(catalog).toHaveBeenCalledWith("tt", { platform: "tiktok" });
  });
});
