/**
 * `/api/social/music/facts` — GET probes every active Instagram/TikTok
 * account's music facts (unknown ones detected on the spot); PUT sets the
 * user's TikTok account type and is browser-only, like the rest of the
 * social settings writes (see `__tests__/unit/security/user-only-routes.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const logSpies = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() }));
vi.mock("@/lib/logger", () => ({ serverLogger: logSpies, mcpLogger: logSpies }));

import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { setAccountMusicFacts, setSocialSettings } from "@/lib/db/settings";
import { __setSocialServiceForTests } from "@/lib/social/service";
import { navigationEmitter } from "@/lib/navigation-events";
import type { SocialAdapter } from "@/lib/social/adapter";
import type { SocialAccount } from "@/lib/social/types";

import { GET, PUT } from "@/app/api/social/music/facts/route";

/** libi's own page: a same-origin browser fetch. */
const PAGE = { host: "127.0.0.1:3461", origin: "http://127.0.0.1:3461", "sec-fetch-site": "same-origin" };
/** A header-less loopback caller — an agent's own shell running curl. */
const CURL = { host: "127.0.0.1:3461" };

const ttAccount: SocialAccount = { id: "tt", platform: "tiktok", username: "tt", displayName: "TT", active: true };
const igAccount: SocialAccount = { id: "ig", platform: "instagram", username: "ig", displayName: "IG", active: true };

const navEvents: Array<{ event: string; payload: unknown }> = [];
navigationEmitter.on("refresh_query", (payload) => navEvents.push({ event: "refresh_query", payload }));

function stubService(overrides: Partial<Record<string, unknown>> = {}) {
  const adapter: Record<string, unknown> = {
    listAccounts: async () => [ttAccount, igAccount],
    musicAccountFacts: vi.fn(async (_accountId: string, platform: string) =>
      platform === "tiktok" ? { tiktokKind: { value: "business", source: "detected", checkedAt: "t" } } : { instagramFacebookLogin: { value: false, source: "detected", checkedAt: "t" } },
    ),
    ...overrides,
  };
  __setSocialServiceForTests({
    async status() {
      return { providerId: "zernio" as const, connected: true, needsReconnect: false, scopes: [], connectedAt: "x" };
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

function put(body: unknown, headers: Record<string, string>) {
  return new Request("http://127.0.0.1:3461/api/social/music/facts", {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  createTestDb();
  setSocialSettings({ providerId: "zernio", timezone: null, defaults: { instagramType: "reel", aiLabel: true }, pollSeconds: 30 });
  navEvents.length = 0;
  for (const spy of Object.values(logSpies)) spy.mockClear();
});
afterEach(() => resetTestDb());

describe("GET /api/social/music/facts", () => {
  it("probes unknown accounts and answers facts by account id", async () => {
    stubService();
    const res = await GET(new Request("http://127.0.0.1:3461/api/social/music/facts", { headers: PAGE }));
    expect(await res.json()).toEqual({
      facts: {
        tt: { tiktokKind: expect.objectContaining({ value: "business", source: "detected" }) },
        ig: { instagramFacebookLogin: expect.objectContaining({ value: false }) },
      },
    });
  });

  it("re-probes a stored NEGATIVE on every read (a user who just reconnected sees it after reload), never a positive", async () => {
    const now = new Date().toISOString();
    setAccountMusicFacts("zernio:tt", { tiktokKind: { value: "business", source: "detected", checkedAt: now } });
    setAccountMusicFacts("zernio:ig", { instagramFacebookLogin: { value: false, source: "detected", checkedAt: now } });
    const a = stubService({
      musicAccountFacts: vi.fn(async () => ({ instagramFacebookLogin: { value: true, source: "detected", checkedAt: new Date().toISOString() } })),
    });
    const res = await GET(new Request("http://127.0.0.1:3461/api/social/music/facts", { headers: PAGE }));
    expect((await res.json()).facts.ig.instagramFacebookLogin.value).toBe(true);
    expect(a.musicAccountFacts).toHaveBeenCalledTimes(1);
    expect(a.musicAccountFacts).toHaveBeenCalledWith("ig", "instagram");
  });

  it("refuses another site's request before probing (the probe calls Zernio and writes the facts)", async () => {
    const a = stubService();
    const res = await GET(new Request("http://127.0.0.1:3461/api/social/music/facts", { headers: { host: "127.0.0.1:3461", "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" } }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_site_read");
    expect(a.musicAccountFacts).not.toHaveBeenCalled();
  });
});

describe("PUT /api/social/music/facts", () => {
  it("sets the kind from libi's own page and refuses a header-less caller", async () => {
    stubService();
    expect((await PUT(put({ accountId: "tt", tiktokKind: "personal" }, CURL))).status).toBe(403);
    const ok = await PUT(put({ accountId: "tt", tiktokKind: "personal" }, PAGE));
    expect((await ok.json()).facts.tt.tiktokKind).toMatchObject({ value: "personal", source: "user" });
    expect(navEvents).toContainEqual({ event: "refresh_query", payload: { queryKey: "social" } });
  });
});
