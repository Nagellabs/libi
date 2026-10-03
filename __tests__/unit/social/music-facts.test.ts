import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const logSpies = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() }));
vi.mock("@/lib/logger", () => ({ serverLogger: logSpies, mcpLogger: logSpies }));

import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getAccountMusicFacts, setAccountMusicFacts, setSocialSettings } from "@/lib/db/settings";
import { factsKey, mergeDetected, recordCatalogOutcome, resolveAccountFacts, setUserTikTokKind } from "@/lib/social/music-facts";
import type { SocialAdapter } from "@/lib/social/adapter";

beforeEach(() => {
  createTestDb();
  setSocialSettings({ providerId: "zernio", timezone: null, defaults: { instagramType: "reel", aiLabel: true }, pollSeconds: 30 });
});
afterEach(() => resetTestDb());

const probe = (answer: object) => ({ musicAccountFacts: vi.fn(async () => answer) }) as unknown as SocialAdapter & { musicAccountFacts: ReturnType<typeof vi.fn> };
const detectedBusiness = { tiktokKind: { value: "business", source: "detected", checkedAt: "t" } };

describe("account music facts", () => {
  it("probes an unknown TikTok once, stores it, and logs account_kind_detected", async () => {
    const a = probe(detectedBusiness);
    expect((await resolveAccountFacts(a, "zernio", { id: "tt", platform: "tiktok" })).tiktokKind?.value).toBe("business");
    await resolveAccountFacts(a, "zernio", { id: "tt", platform: "tiktok" });
    expect(a.musicAccountFacts).toHaveBeenCalledTimes(1);
    expect(getAccountMusicFacts(factsKey("zernio", "tt")).tiktokKind?.value).toBe("business");
    expect(logSpies.info).toHaveBeenCalledWith(expect.objectContaining({ tag: "social-music", op: "account_kind_detected", platform: "tiktok", value: "business" }), expect.any(String));
  });

  it("never overwrites the user's choice", () => {
    const user = { tiktokKind: { value: "personal" as const, source: "user" as const, checkedAt: "t0" } };
    expect(mergeDetected(user, detectedBusiness as never)).toEqual(user);
  });

  it("the user sets the kind", async () => {
    setUserTikTokKind("zernio", "tt", "personal");
    const a = probe(detectedBusiness);
    expect((await resolveAccountFacts(a, "zernio", { id: "tt", platform: "tiktok" })).tiktokKind).toMatchObject({ value: "personal", source: "user" });
    expect(a.musicAccountFacts).not.toHaveBeenCalled();
  });

  it("a blip leaves the fact unknown (retried next time); non-composable platforms are never probed", async () => {
    const a = probe({});
    expect(await resolveAccountFacts(a, "zernio", { id: "tt", platform: "tiktok" })).toEqual({});
    await resolveAccountFacts(a, "zernio", { id: "tt", platform: "tiktok" });
    expect(a.musicAccountFacts).toHaveBeenCalledTimes(2);
    await resolveAccountFacts(a, "zernio", { id: "yt", platform: "youtube" });
    expect(a.musicAccountFacts).toHaveBeenCalledTimes(2);
  });
  describe("a detected NEGATIVE (personal TikTok, Instagram Login) is re-checked — the user may have reconnected", () => {
    const NOW = new Date("2026-09-28T12:00:00.000Z");
    const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

    it("re-probes a detected personal TikTok older than an hour, and picks up the new answer", async () => {
      setAccountMusicFacts(factsKey("zernio", "tt"), { tiktokKind: { value: "personal", source: "detected", checkedAt: minsAgo(61) } });
      const a = probe(detectedBusiness);
      const f = await resolveAccountFacts(a, "zernio", { id: "tt", platform: "tiktok" }, { now: NOW });
      expect(a.musicAccountFacts).toHaveBeenCalledTimes(1);
      expect(f.tiktokKind?.value).toBe("business");
    });

    it("leaves a fresh detected negative alone", async () => {
      setAccountMusicFacts(factsKey("zernio", "tt"), { tiktokKind: { value: "personal", source: "detected", checkedAt: minsAgo(10) } });
      setAccountMusicFacts(factsKey("zernio", "ig"), { instagramFacebookLogin: { value: false, source: "detected", checkedAt: minsAgo(10) } });
      const a = probe({});
      await resolveAccountFacts(a, "zernio", { id: "tt", platform: "tiktok" }, { now: NOW });
      await resolveAccountFacts(a, "zernio", { id: "ig", platform: "instagram" }, { now: NOW });
      expect(a.musicAccountFacts).not.toHaveBeenCalled();
    });

    it("re-probes an old Instagram-Login account", async () => {
      setAccountMusicFacts(factsKey("zernio", "ig"), { instagramFacebookLogin: { value: false, source: "detected", checkedAt: minsAgo(120) } });
      const a = probe({ instagramFacebookLogin: { value: true, source: "detected", checkedAt: NOW.toISOString() } });
      const f = await resolveAccountFacts(a, "zernio", { id: "ig", platform: "instagram" }, { now: NOW });
      expect(f.instagramFacebookLogin?.value).toBe(true);
    });

    it("recheckNegative (the Settings read) re-probes a negative whatever its age — never a positive", async () => {
      setAccountMusicFacts(factsKey("zernio", "tt"), { tiktokKind: { value: "personal", source: "detected", checkedAt: minsAgo(1) } });
      setAccountMusicFacts(factsKey("zernio", "tt2"), { tiktokKind: { value: "business", source: "detected", checkedAt: minsAgo(600) } });
      const a = probe(detectedBusiness);
      await resolveAccountFacts(a, "zernio", { id: "tt", platform: "tiktok" }, { now: NOW, recheckNegative: true });
      await resolveAccountFacts(a, "zernio", { id: "tt2", platform: "tiktok" }, { now: NOW, recheckNegative: true });
      expect(a.musicAccountFacts).toHaveBeenCalledTimes(1);
      expect(a.musicAccountFacts).toHaveBeenCalledWith("tt", "tiktok");
    });

    it("a re-probe that finds the same value only refreshes checkedAt: account_kind_detected is logged once, not per read", async () => {
      // The Settings read re-probes an Instagram-Login account every time
      // (recheckNegative); each one used to log the same detection (QA F4).
      setAccountMusicFacts(factsKey("zernio", "ig"), { instagramFacebookLogin: { value: false, source: "detected", checkedAt: minsAgo(5) } });
      logSpies.info.mockClear();
      const a = probe({ instagramFacebookLogin: { value: false, source: "detected", checkedAt: NOW.toISOString() } });
      await resolveAccountFacts(a, "zernio", { id: "ig", platform: "instagram" }, { now: NOW, recheckNegative: true });
      await resolveAccountFacts(a, "zernio", { id: "ig", platform: "instagram" }, { now: NOW, recheckNegative: true });
      expect(a.musicAccountFacts).toHaveBeenCalledTimes(2);
      expect(getAccountMusicFacts(factsKey("zernio", "ig")).instagramFacebookLogin?.checkedAt).toBe(NOW.toISOString());
      expect(logSpies.info.mock.calls.filter((c) => (c[0] as { op?: string }).op === "account_kind_detected")).toHaveLength(0);

      // …and a CHANGE (the user reconnected with Facebook Login) is logged.
      a.musicAccountFacts.mockResolvedValueOnce({ instagramFacebookLogin: { value: true, source: "detected", checkedAt: NOW.toISOString() } });
      await resolveAccountFacts(a, "zernio", { id: "ig", platform: "instagram" }, { now: NOW, recheckNegative: true });
      expect(logSpies.info).toHaveBeenCalledWith(
        expect.objectContaining({ op: "account_kind_detected", platform: "instagram", value: "facebook_login" }),
        expect.any(String),
      );
    });

    it("never re-probes the user's own choice, however old", async () => {
      setAccountMusicFacts(factsKey("zernio", "tt"), { tiktokKind: { value: "personal", source: "user", checkedAt: minsAgo(6000) } });
      const a = probe(detectedBusiness);
      const f = await resolveAccountFacts(a, "zernio", { id: "tt", platform: "tiktok" }, { now: NOW, recheckNegative: true });
      expect(a.musicAccountFacts).not.toHaveBeenCalled();
      expect(f.tiktokKind).toMatchObject({ value: "personal", source: "user" });
    });
  });

  describe("a catalog read is evidence about the account (recordCatalogOutcome)", () => {
    const NOW = new Date("2026-09-28T12:00:00.000Z");
    const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
    const ig = { id: "ig", platform: "instagram" as const };
    const tt = { id: "tt", platform: "tiktok" as const };
    const tracks = { tracks: [{ id: "1", title: "T", kind: "search" as const }] };

    it("a successful Instagram search clears a FRESH 'needs Facebook Login' fact, with no probe", async () => {
      setAccountMusicFacts(factsKey("zernio", "ig"), { instagramFacebookLogin: { value: false, source: "detected", checkedAt: minsAgo(5) } });
      recordCatalogOutcome("zernio", ig, tracks, NOW);
      expect(getAccountMusicFacts(factsKey("zernio", "ig")).instagramFacebookLogin).toEqual({ value: true, source: "detected", checkedAt: NOW.toISOString() });
      const a = probe({});
      const f = await resolveAccountFacts(a, "zernio", ig, { now: NOW });
      expect(f.instagramFacebookLogin?.value).toBe(true);
      expect(a.musicAccountFacts).not.toHaveBeenCalled();
      expect(logSpies.info).toHaveBeenCalledWith(expect.objectContaining({ op: "account_kind_detected", platform: "instagram", value: "facebook_login" }), expect.any(String));
    });

    it("a successful TikTok read records business over a detected personal, but never over the user's own choice", () => {
      setAccountMusicFacts(factsKey("zernio", "tt"), { tiktokKind: { value: "personal", source: "detected", checkedAt: minsAgo(5) } });
      recordCatalogOutcome("zernio", tt, tracks, NOW);
      expect(getAccountMusicFacts(factsKey("zernio", "tt")).tiktokKind).toMatchObject({ value: "business", source: "detected" });
      setUserTikTokKind("zernio", "tt2", "personal");
      recordCatalogOutcome("zernio", { id: "tt2", platform: "tiktok" }, tracks, NOW);
      expect(getAccountMusicFacts(factsKey("zernio", "tt2")).tiktokKind).toMatchObject({ value: "personal", source: "user" });
    });

    it("a refusal that names the cause records it (a user who went back to Instagram Login)", () => {
      setAccountMusicFacts(factsKey("zernio", "ig"), { instagramFacebookLogin: { value: true, source: "detected", checkedAt: minsAgo(500) } });
      recordCatalogOutcome("zernio", ig, { unavailable: { reason: "needs_facebook_login" } }, NOW);
      expect(getAccountMusicFacts(factsKey("zernio", "ig")).instagramFacebookLogin).toMatchObject({ value: false, checkedAt: NOW.toISOString() });
    });

    it("any other failure says nothing about the account", () => {
      setAccountMusicFacts(factsKey("zernio", "ig"), { instagramFacebookLogin: { value: false, source: "detected", checkedAt: minsAgo(5) } });
      recordCatalogOutcome("zernio", ig, { unavailable: { reason: "error" } }, NOW);
      recordCatalogOutcome("zernio", ig, { unavailable: { reason: "unsupported" } }, NOW);
      expect(getAccountMusicFacts(factsKey("zernio", "ig")).instagramFacebookLogin).toMatchObject({ value: false, checkedAt: minsAgo(5) });
      expect(getAccountMusicFacts(factsKey("zernio", "yt"))).toEqual({});
      recordCatalogOutcome("zernio", { id: "yt", platform: "youtube" } as never, tracks, NOW);
      expect(getAccountMusicFacts(factsKey("zernio", "yt"))).toEqual({});
    });
  });
});
