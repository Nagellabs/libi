import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getSocialSettings, setSocialSettings, getAccountMusicFacts, setAccountMusicFacts } from "@/lib/db/settings";

beforeEach(() => {
  createTestDb();
});
afterEach(() => {
  resetTestDb();
});

describe("SocialSettings", () => {
  it("defaults when nothing is stored: no provider, OS timezone, reel, AI label on, 30 s poll", () => {
    const s = getSocialSettings();
    expect(s).toEqual({ providerId: null, timezone: null, defaults: { instagramType: "reel", aiLabel: true }, pollSeconds: 30 });
  });
  it("round-trips and ignores junk", () => {
    setSocialSettings({ providerId: "zernio", timezone: "Asia/Bangkok", defaults: { instagramType: "story", aiLabel: false }, pollSeconds: 30 });
    expect(getSocialSettings().providerId).toBe("zernio");
    expect(getSocialSettings().defaults.instagramType).toBe("story");
    // a stored unknown provider reads as none — the catalog decides what exists
    setSocialSettings({ ...getSocialSettings(), providerId: "nope" as never });
    expect(getSocialSettings().providerId).toBeNull();
  });
  it("keeps account facts across a settings PUT that does not carry them, and tolerates junk", () => {
    setSocialSettings({ providerId: "zernio", timezone: null, defaults: { instagramType: "reel", aiLabel: true }, pollSeconds: 30 });
    setAccountMusicFacts("zernio:tt", { tiktokKind: { value: "business", source: "detected", checkedAt: "t" } });
    setSocialSettings({ providerId: "zernio", timezone: "Asia/Bangkok", defaults: { instagramType: "reel", aiLabel: true }, pollSeconds: 30 });
    expect(getSocialSettings().accountFacts).toEqual({ "zernio:tt": { tiktokKind: { value: "business", source: "detected", checkedAt: "t" } } });
    setAccountMusicFacts("zernio:bad", { tiktokKind: { value: "enterprise" } } as never);
    expect(getAccountMusicFacts("zernio:bad")).toEqual({});
  });
});
