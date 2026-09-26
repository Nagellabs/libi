import { describe, it, expect } from "vitest";
import { defaultOptions, seedFromCreatorInfo } from "@/components/social/composer/types";
import type { TikTokCreatorInfo, TargetOptions } from "@/lib/social/types";

function info(over: Partial<TikTokCreatorInfo["interactions"]> = {}): TikTokCreatorInfo {
  return {
    accountId: "acct-tt",
    privacyLevels: ["PUBLIC_TO_EVERYONE"],
    maxVideoSeconds: 600,
    canPostMore: true,
    interactions: {
      // What the live account actually returns: allowed, field required, and
      // TikTok's own suggested default OFF for all three.
      allow_comment: { enabled: true, required: true, default: false },
      allow_duet: { enabled: true, required: true, default: false },
      allow_stitch: { enabled: true, required: true, default: false },
      ...over,
    },
  };
}

const tiktokDraft = () => defaultOptions("tiktok", { instagramType: "reel", aiLabel: true }) as TargetOptions & { platform: "tiktok" };

describe("seedFromCreatorInfo", () => {
  it("turns every allowed interaction ON, ignoring TikTok's own default of off", () => {
    const seeded = seedFromCreatorInfo(tiktokDraft(), info(), true);
    expect(seeded.tiktok.allowComment).toBe(true);
    expect(seeded.tiktok.allowDuet).toBe(true);
    expect(seeded.tiktok.allowStitch).toBe(true);
  });

  it("leaves an interaction the account is not allowed OFF", () => {
    // `enabled: false` is the one thing the on-by-default rule must not
    // override: TikTok rejects a post that asks for an interaction the account
    // cannot have.
    const seeded = seedFromCreatorInfo(tiktokDraft(), info({ allow_duet: { enabled: false, required: true, default: false } }), true);
    expect(seeded.tiktok.allowComment).toBe(true);
    expect(seeded.tiktok.allowDuet).toBe(false);
    expect(seeded.tiktok.allowStitch).toBe(true);
  });

  it("does not touch the switches once the user (or a restored draft) has had a say", () => {
    const chosen: TargetOptions & { platform: "tiktok" } = {
      platform: "tiktok",
      tiktok: { ...tiktokDraft().tiktok, privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: false, allowDuet: false, allowStitch: false },
    };
    const seeded = seedFromCreatorInfo(chosen, info(), false);
    // The SAME object back — nothing changed, so nothing re-renders.
    expect(seeded).toBe(chosen);
  });

  it("replaces a privacy level the platform no longer offers", () => {
    const stale: TargetOptions & { platform: "tiktok" } = {
      platform: "tiktok",
      tiktok: { ...tiktokDraft().tiktok, privacyLevel: "SELF_ONLY" },
    };
    expect(seedFromCreatorInfo(stale, info(), false).tiktok.privacyLevel).toBe("PUBLIC_TO_EVERYONE");
  });
});
