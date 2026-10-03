import { describe, it, expect } from "vitest";
import { planInboxSend } from "@/lib/social/inbox";
import { toUpdateBody } from "@/lib/social/providers/zernio/normalize";
import type { SocialPost, TargetOptions } from "@/lib/social/types";

const TT: TargetOptions = {
  platform: "tiktok",
  tiktok: { privacyLevel: "SELF_ONLY", allowComment: false, allowDuet: false, allowStitch: false, commercialContentType: "none", contentPreviewConfirmed: true, expressConsentGiven: true },
  music: { mode: "strip" },
};
const IG: TargetOptions = { platform: "instagram", instagram: { contentType: "reel" } };

const draft = (over: Partial<SocialPost> = {}): SocialPost => ({
  id: "p1",
  status: "draft",
  content: "hi",
  createdAt: "2026-10-03T00:00:00.000Z",
  media: [{ url: "https://m/media/x.mp4", type: "video" }],
  tags: [],
  targets: [{ platform: "tiktok", accountId: "tt1", status: "pending" }],
  libi: { pieceId: "piece-1", pieceName: "Piece", exportFile: "e.mp4", requestId: "r1", mediaUrl: "https://m/temp/x.mp4", targetOptions: [TT] },
  ...over,
});

describe("planInboxSend", () => {
  it("a TikTok-only draft libi made: publish now with the draft handoff, the ORIGINAL media url and the stamp kept", () => {
    const plan = planInboxSend(draft());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.platforms).toEqual(["tiktok"]);
    expect(plan.patch.when).toEqual({ mode: "now" });
    expect(plan.patch.targets?.[0]).toMatchObject({ platform: "tiktok", accountId: "tt1", options: { music: { mode: "draft" }, tiktok: { privacyLevel: "SELF_ONLY" } } });
    expect(plan.patch.media).toEqual([{ url: "https://m/temp/x.mp4", type: "video" }]);
    expect(plan.patch.libi).toMatchObject({ pieceId: "piece-1", requestId: "r1", mediaUrl: "https://m/temp/x.mp4" });
  });

  it("the adapter turns that patch into the provider's inbox flag and a publish", () => {
    const plan = planInboxSend(draft());
    if (!plan.ok) throw new Error("expected a plan");
    const body = toUpdateBody({ requestId: "r2", ...plan.patch });
    expect(body.is_draft).toBe(false);
    expect(body.publish_now).toBe(true);
    expect((body.platforms as Array<Record<string, unknown>>)[0]).toMatchObject({ platform: "tiktok", platformSpecificData: { tiktokSettings: { draft: true } } });
  });

  it("refuses a draft that also goes to a platform with no inbox: the same call would post there", () => {
    const plan = planInboxSend(
      draft({
        targets: [
          { platform: "instagram", accountId: "ig1", status: "pending" },
          { platform: "tiktok", accountId: "tt1", status: "pending" },
        ],
        libi: { pieceId: "p", targetOptions: [IG, TT] },
      }),
    );
    expect(plan).toMatchObject({ ok: false, code: "other_targets" });
    expect(plan.ok ? "" : plan.message).toMatch(/Instagram/);
  });

  it("refuses an Instagram-only draft and a post that is not a draft", () => {
    expect(planInboxSend(draft({ targets: [{ platform: "instagram", accountId: "ig1", status: "pending" }], libi: { pieceId: "p", targetOptions: [IG] } }))).toMatchObject({ ok: false, code: "no_inbox_platform" });
    expect(planInboxSend(draft({ status: "scheduled" }))).toMatchObject({ ok: false, code: "not_a_draft" });
    expect(planInboxSend(draft({ status: "published" }))).toMatchObject({ ok: false, code: "not_a_draft" });
  });

  it("refuses a draft libi holds no settings for (made with the agent's own provider tools)", () => {
    expect(planInboxSend(draft({ libi: undefined }))).toMatchObject({ ok: false, code: "no_settings" });
    expect(planInboxSend(draft({ libi: { pieceId: "p" } }))).toMatchObject({ ok: false, code: "no_settings" });
  });

  it("without a stamped media url it sends no media (the provider keeps the draft's own)", () => {
    const plan = planInboxSend(draft({ libi: { pieceId: "p", targetOptions: [TT] } }));
    expect(plan.ok && plan.patch.media).toBeUndefined();
  });
});
