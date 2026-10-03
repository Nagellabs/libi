/**
 * `/api/social/music/{plan,catalog,track}` — the read-only music routes the
 * composer, the Posting tab and `libi.social_music_search` share. Driven over
 * `__setSocialServiceForTests` with a stub adapter; no real provider traffic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
import { getAccountMusicFacts, setAccountMusicFacts, setSocialSettings } from "@/lib/db/settings";
import { __setSocialServiceForTests } from "@/lib/social/service";
import { SocialError } from "@/lib/social/errors";
import type { SocialAdapter } from "@/lib/social/adapter";

import { POST as planRoute } from "@/app/api/social/music/plan/route";
import { GET as catalogRoute } from "@/app/api/social/music/catalog/route";
import { GET as trackRoute } from "@/app/api/social/music/track/route";

const TT_TRACKS = { tracks: [{ id: "tt-1", title: "Self Aware", artist: "Mark Allan Wolfe", durationSec: 227, kind: "trending" }] };

function stubService(overrides: Partial<Record<string, unknown>> = {}) {
  const adapter: Record<string, unknown> = {
    musicAccountFacts: vi.fn(async () => ({})),
    musicCatalog: vi.fn(async () => TT_TRACKS),
    getCatalogTrack: vi.fn(async () => null),
    ...overrides,
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
  return adapter;
}

const get = (path: string) => new Request(`http://127.0.0.1:3461${path}`);

beforeEach(() => {
  createTestDb();
  createTempStorageDir();
  seedPiece(getDb() as never, { id: "p1" });
  setSocialSettings({ providerId: "zernio", timezone: null, defaults: { instagramType: "reel", aiLabel: true }, pollSeconds: 30 });
});
afterEach(() => {
  __setSocialServiceForTests(null);
  resetTestDb();
  cleanupTempDir();
});

describe("GET /api/social/music/catalog", () => {
  it("answers the adapter's catalog for a TikTok account", async () => {
    const a = stubService();
    const res = await catalogRoute(get("/api/social/music/catalog?platform=tiktok&accountId=tt"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(TT_TRACKS);
    expect(a.musicCatalog).toHaveBeenCalledWith("tt", { platform: "tiktok" });
  });

  it("passes the search words to Instagram only", async () => {
    const a = stubService();
    await catalogRoute(get("/api/social/music/catalog?platform=instagram&accountId=ig&q=%20espresso%20"));
    expect(a.musicCatalog).toHaveBeenCalledWith("ig", { platform: "instagram", query: "espresso" });
    await catalogRoute(get("/api/social/music/catalog?platform=tiktok&accountId=tt&q=espresso"));
    expect(a.musicCatalog).toHaveBeenLastCalledWith("tt", { platform: "tiktok" });
  });

  it("a successful read clears a cached 'Reconnect with Facebook Login' fact, so the next plan no longer says it", async () => {
    // The user reconnected Instagram through Facebook Login inside the fact's hour.
    setAccountMusicFacts("zernio:ig", { instagramFacebookLogin: { value: false, source: "detected", checkedAt: new Date().toISOString() } });
    stubService({ providerId: "zernio", musicCatalog: vi.fn(async () => ({ tracks: [{ id: "i1", title: "Espresso", kind: "search" }] })) });
    expect(getAccountMusicFacts("zernio:ig").instagramFacebookLogin?.value).toBe(false);
    const res = await catalogRoute(get("/api/social/music/catalog?platform=instagram&accountId=ig&q=espresso"));
    expect(res.status).toBe(200);
    expect(getAccountMusicFacts("zernio:ig").instagramFacebookLogin?.value).toBe(true);
  });

  it("a refusal naming Facebook Login records it; a plain error leaves the fact alone", async () => {
    stubService({ providerId: "zernio", musicCatalog: vi.fn(async () => ({ unavailable: { reason: "needs_facebook_login" } })) });
    await catalogRoute(get("/api/social/music/catalog?platform=instagram&accountId=ig"));
    expect(getAccountMusicFacts("zernio:ig").instagramFacebookLogin?.value).toBe(false);
    stubService({ providerId: "zernio", musicCatalog: vi.fn(async () => ({ unavailable: { reason: "error" } })) });
    await catalogRoute(get("/api/social/music/catalog?platform=instagram&accountId=ig2"));
    expect(getAccountMusicFacts("zernio:ig2")).toEqual({});
  });

  it("refuses a platform with no catalog, and a missing account", async () => {
    const a = stubService();
    expect((await catalogRoute(get("/api/social/music/catalog?platform=youtube&accountId=yt"))).status).toBe(400);
    expect((await catalogRoute(get("/api/social/music/catalog?platform=tiktok"))).status).toBe(400);
    expect(a.musicCatalog).not.toHaveBeenCalled();
  });

  it("maps a provider error through socialErrorToResponse", async () => {
    stubService({ musicCatalog: vi.fn(async () => { throw new SocialError("unauthorized", "nope"); }) });
    const res = await catalogRoute(get("/api/social/music/catalog?platform=tiktok&accountId=tt"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "needs_reconnect" });
  });
});

describe("GET /api/social/music/track", () => {
  it("answers { track: null } when the provider has no such track", async () => {
    const a = stubService();
    const res = await trackRoute(get("/api/social/music/track?accountId=ig&trackId=x"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ track: null });
    expect(a.getCatalogTrack).toHaveBeenCalledWith("ig", "x");
  });

  it("answers the track when there is one, and 400 without both ids", async () => {
    const track = { id: "x", title: "Espresso", artist: "Sabrina Carpenter", kind: "search" };
    stubService({ getCatalogTrack: vi.fn(async () => track) });
    expect(await (await trackRoute(get("/api/social/music/track?accountId=ig&trackId=x"))).json()).toEqual({ track });
    expect((await trackRoute(get("/api/social/music/track?accountId=ig"))).status).toBe(400);
  });
});

describe("the Zernio-reading GETs refuse another site's request", () => {
  const crossSite = (path: string) => new Request(`http://127.0.0.1:3461${path}`, { headers: { host: "127.0.0.1:3461", "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" } });

  it("catalog and track → 403 cross_site_read, and nothing reaches the adapter", async () => {
    const a = stubService();
    for (const res of [
      await catalogRoute(crossSite("/api/social/music/catalog?platform=tiktok&accountId=tt")),
      await trackRoute(crossSite("/api/social/music/track?accountId=ig&trackId=x")),
    ]) {
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("cross_site_read");
    }
    expect(a.musicCatalog).not.toHaveBeenCalled();
    expect(a.getCatalogTrack).not.toHaveBeenCalled();
  });

  it("libi's own page still reads them", async () => {
    stubService();
    const own = { headers: { host: "127.0.0.1:3461", "sec-fetch-site": "same-origin" } };
    expect((await catalogRoute(new Request("http://127.0.0.1:3461/api/social/music/catalog?platform=tiktok&accountId=tt", own))).status).toBe(200);
    expect((await trackRoute(new Request("http://127.0.0.1:3461/api/social/music/track?accountId=ig&trackId=x", own))).status).toBe(200);
  });
});

describe("POST /api/social/music/plan", () => {
  const post = (body: unknown) =>
    planRoute(new Request("http://127.0.0.1:3461/api/social/music/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

  it("plans a piece with no music: include, nothing to handle", async () => {
    stubService();
    const res = await post({ pieceId: "p1", targets: [{ platform: "youtube" }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      copyrighted: false,
      hasMusic: false,
      targets: [{ platform: "youtube", plan: { mode: "include", sentence: "This piece has no music to handle.", exportVariant: "with-song" }, music: { mode: "include" } }],
    });
    expect(body.variants["with-song"]).toEqual({ purpose: "social", excludedFileIds: [], carriesCopyrighted: false });
  });

  it("refuses an unknown platform or a bad body", async () => {
    stubService();
    expect((await post({ pieceId: "p1", targets: [{ platform: "myspace" }] })).status).toBe(400);
    expect((await post({ targets: [] })).status).toBe(400);
  });
});
