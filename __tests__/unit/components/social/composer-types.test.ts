import { describe, it, expect } from "vitest";
import {
  defaultOptions,
  seedFromCreatorInfo,
  exportVariantOf,
  mixedVariants,
  exportFitsVariant,
  STEPS,
  STEP_LABEL,
  type TargetDraft,
} from "@/components/social/composer/types";
import type { TikTokCreatorInfo, TargetOptions } from "@/lib/social/types";

describe("STEPS", () => {
  it("Music is its own step, between Targets and Caption", () => {
    expect(STEPS).toEqual(["media", "targets", "music", "caption", "when", "review"]);
    expect(STEP_LABEL.music).toBe("Music");
  });
});

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

describe("music helpers", () => {
  const TT_OPTIONS = tiktokDraft().tiktok;
  const CREATOR_INFO = info();
  const draft = (music?: object): TargetDraft =>
    ({ platform: "tiktok", accountId: "a", options: { platform: "tiktok", tiktok: TT_OPTIONS, ...(music ? { music } : {}) } as TargetDraft["options"] });

  it("variants", () => {
    expect(exportVariantOf(draft({ mode: "include" }))).toBe("with-song");
    expect(exportVariantOf(draft({ mode: "draft" }))).toBe("without-song");
    expect(exportVariantOf(draft())).toBe("without-song");
    expect(mixedVariants([draft({ mode: "include" }), draft({ mode: "strip" })])).toBe(true);
    expect(mixedVariants([draft({ mode: "attach" }), draft({ mode: "strip" })])).toBe(false);
  });

  it("an export fits a variant only when its decision says so", () => {
    const e = { filePath: "x", width: 1, height: 1, sizeBytes: 1, durationSeconds: 1 };
    expect(
      exportFitsVariant({ ...e, audioDecision: { purpose: "social", excludedFileIds: ["s"], carriesCopyrighted: false } }, "without-song"),
    ).toBe(true);
    expect(
      exportFitsVariant({ ...e, audioDecision: { purpose: "personal", excludedFileIds: [], carriesCopyrighted: true } }, "without-song"),
    ).toBe(false);
    expect(exportFitsVariant(e, "without-song")).toBe(false);
  });

  it("seedFromCreatorInfo keeps the target's music", () => {
    const o = { platform: "tiktok" as const, tiktok: { ...TT_OPTIONS, privacyLevel: "GONE" }, music: { mode: "draft" as const } };
    expect(seedFromCreatorInfo(o, CREATOR_INFO, true).music).toEqual({ mode: "draft" });
  });
});
