import { describe, it, expect } from "vitest";
import account from "@/lib/social/providers/zernio/fixtures/account.json";
import draft from "@/lib/social/providers/zernio/fixtures/post-draft.json";
import partial from "@/lib/social/providers/zernio/fixtures/post-partial.json";
import creator from "@/lib/social/providers/zernio/fixtures/creator-info.json";
import analyticsReady from "@/lib/social/providers/zernio/fixtures/analytics-ready.json";
import analyticsPending from "@/lib/social/providers/zernio/fixtures/analytics-pending.json";
import campaigns from "@/lib/social/providers/zernio/fixtures/campaigns.json";
import {
  toAccount,
  toHealth,
  toPost,
  toCreatorInfo,
  toCreateBody,
  toAnalytics,
  toUpdateBody,
  toCampaign,
  toAdAccount,
  toDryRun,
} from "@/lib/social/providers/zernio/normalize";

describe("zernio normalize", () => {
  it("a draft keeps NO scheduledFor even though its platform rows carry one", () => {
    const p = toPost(draft);
    expect(p.status).toBe("draft");
    expect(p.scheduledFor).toBeUndefined();
    expect(p.targets.map((t) => t.status)).toEqual(["pending", "pending"]);
    expect(p.libi).toEqual({ pieceId: "piece_1", pieceName: "Cutdown v3", exportFile: "export_1080x1920.mp4", appVersion: "0.1.16" });
    expect(p.targets[0].options).toEqual({ platform: "instagram", instagram: { contentType: "reel", shareToFeed: true, isAiGenerated: true } });
    expect(p.targets[1].options).toMatchObject({ platform: "tiktok", tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true, allowDuet: false, allowStitch: false } });
  });

  it("a partial post keeps each target's errorMessage and url verbatim", () => {
    const p = toPost(partial);
    expect(p.status).toBe("partial");
    expect(p.targets.find((t) => t.platform === "tiktok")?.error).toBe("Selected privacy level 'SELF_ONLY' is not available for this creator");
    expect(p.targets.find((t) => t.platform === "instagram")?.url).toMatch(/^https:\/\/www\.instagram\.com\//);
  });

  it("pulls accountId out of the nested object, never treats it as a bare string", () => {
    const p = toPost(partial);
    // fixture pins the verified invariant: platforms[].accountId is an OBJECT
    // ({ _id, platform, username, ... }), not a string.
    expect(typeof (partial.platforms[0] as { accountId: unknown }).accountId).toBe("object");
    expect(p.targets[0].accountId).toBe("6aae6b468d284ffb211ade1e");
    expect(p.targets[1].accountId).toBe("6aae6ba98d284ffb211ae03a");
  });

  it("creator info is rendered from what TikTok returned — nothing invented", () => {
    const c = toCreatorInfo("6aae6ba98d284ffb211ae03a", creator);
    expect(c.privacyLevels).toEqual(["PUBLIC_TO_EVERYONE"]);
    expect(c.maxVideoSeconds).toBe(600);
    // `enabled` is the field that decides whether the switch may be on at all;
    // it was being dropped, so an account that forbids an interaction looked
    // identical to one that merely defaults it off.
    expect(c.interactions.allow_duet).toEqual({ enabled: true, required: true, default: false });
    expect(c.interactions.allow_comment).toEqual({ enabled: true, required: true, default: false });
    expect(c.interactions.allow_stitch).toEqual({ enabled: true, required: true, default: false });
    expect(c.canPostMore).toBe(true);
    expect(c.accountId).toBe("6aae6ba98d284ffb211ae03a");
  });

  it("account + health map from the accounts_list / account_health shapes", () => {
    const a = toAccount(account.account);
    expect(a).toMatchObject({ id: "6aae6b468d284ffb211ade1e", platform: "instagram", username: "nagellabs", displayName: "Nagel Labs", active: true });
    const h = toHealth(account.health);
    expect(h).toEqual({ status: "healthy", tokenExpiresAt: "2026-11-19T09:00:00.000Z" });
  });

  it("reads profileId/profileName out of an OBJECT profileId, the verified live shape", () => {
    expect(typeof account.account.profileId).toBe("object");
    const a = toAccount(account.account);
    expect(a.profileId).toBe("6aae6a1e8d284ffb211adc02");
    expect(a.profileName).toBe("Nagel Labs");
  });

  it("still reads a bare string profileId (a shape this normalizer has not seen live)", () => {
    expect(typeof account.accountStringProfileId.profileId).toBe("string");
    const a = toAccount(account.accountStringProfileId);
    expect(a.profileId).toBe("6aae6a1e8d284ffb211adc02");
    expect(a.profileName).toBeUndefined();
  });

  it("toAccount synthesizes health from the row's own tokenExpiresAt/needsReconnection", () => {
    const a = toAccount(account.account);
    expect(a.health).toEqual({ status: "healthy", tokenExpiresAt: "2026-11-18T11:00:22.425Z" });
  });

  it("toAccount carries externalPostCount through, and leaves it undefined when the row doesn't have it", () => {
    // Verified live on `accounts_list_accounts`, 2026-09-20 (fixtures/account.json).
    expect(toAccount(account.account).externalPostCount).toBe(137);
    expect(toAccount({ _id: "x", platform: "instagram", username: "u" }).externalPostCount).toBeUndefined();
  });

  it("toAccount keeps a platform libi's own composer doesn't build for", () => {
    // The agent connects and posts to these through the provider's MCP; the
    // old shape narrowed anything that wasn't instagram/tiktok away, and the
    // analytics path renamed it to "instagram" outright.
    expect(toAccount({ _id: "fb1", platform: "facebook", username: "pagename" }).platform).toBe("facebook");
    expect(toAccount({ _id: "x1", platform: "twitter", username: "handle" }).platform).toBe("twitter");
    expect(toAccount({ _id: "yt1", platform: "youtube", username: "channel" }).platform).toBe("youtube");
  });

  it("toAccount leaves health undefined when the row carries neither signal", () => {
    const a = toAccount({ _id: "x", platform: "instagram", username: "u" });
    expect(a.health).toBeUndefined();
  });

  it("toAccount's synthesized health is reconnect when needsReconnection is true, regardless of tokenExpiresAt", () => {
    const a = toAccount({ _id: "x", platform: "instagram", username: "u", needsReconnection: true });
    expect(a.health).toEqual({ status: "reconnect", tokenExpiresAt: undefined });
  });

  it("a richer toHealth result overrides toAccount's synthesized health without conflict", () => {
    const synthesized = toAccount(account.account).health;
    const richer = toHealth(account.health);
    expect({ ...synthesized, ...richer }).toEqual(richer);
  });

  it("a token that has gone invalid maps to reconnect, regardless of the provider's own status string", () => {
    const h = toHealth({ tokenStatus: { valid: false, expiresAt: "2026-01-01T00:00:00.000Z" }, status: "some_future_enum_value" });
    expect(h).toEqual({ status: "reconnect", tokenExpiresAt: "2026-01-01T00:00:00.000Z" });
  });

  it("analytics 202 -> pending", () => {
    expect(toAnalytics("p", {}, 202).syncStatus).toBe("pending");
  });

  it("analytics ready fixture maps every per-target metric", () => {
    const a = toAnalytics("post_partial_1", analyticsReady);
    expect(a.syncStatus).toBe("ready");
    expect(a.perTarget).toHaveLength(2);
    expect(a.perTarget.find((t) => t.platform === "tiktok")).toMatchObject({ views: 9600, likes: 540, engagementRate: 7.1 });
  });

  it("reads the SINGLE-POST analytics shape — `platformAnalytics`, metrics one level down", () => {
    // The live answer to `analytics_get_analytics({ post_id })`, trimmed to
    // the keys that matter (read off the user's own published Reel,
    // 2026-09-20). It spells the array `platformAnalytics`, not `platforms`,
    // and nests every metric under `analytics`. Read flat, this normalized to
    // a card with 135 impressions missing and every other number undefined.
    const live = {
      postId: "6aae6b48810ddf2b1c53bdf9",
      status: "published",
      syncStatus: "synced",
      isExternal: true,
      analytics: { impressions: 135, reach: 114, views: 135, likes: 1, engagementRate: 0.74, lastUpdated: "2026-09-19 11:00:24" },
      platformAnalytics: [
        {
          platform: "instagram",
          status: "published",
          accountId: "6aae6b468d284ffb211ade1e",
          syncStatus: "synced",
          analytics: { impressions: 135, reach: 114, views: 135, likes: 1, comments: 0, shares: 0, saves: 0, engagementRate: 0.74 },
        },
      ],
    };
    const a = toAnalytics("6aae6b48810ddf2b1c53bdf9", live);
    expect(a.syncStatus).toBe("ready");
    expect(a.perTarget).toEqual([
      { platform: "instagram", impressions: 135, reach: 114, views: 135, likes: 1, comments: 0, shares: 0, saves: 0, engagementRate: 0.74 },
    ]);
    // `lastUpdated` is not ISO on the wire — "2026-09-19 11:00:24", no zone.
    expect(a.lastUpdated).toBe("2026-09-19T11:00:24Z");
  });

  it("an analytics row for a platform libi doesn't compose for keeps its own name", () => {
    // Regression: the row's platform used to fall back to "instagram" for
    // anything unrecognized, so a YouTube post the AGENT published showed its
    // numbers under an Instagram column.
    const a = toAnalytics("p1", {
      syncStatus: "synced",
      platformAnalytics: [{ platform: "youtube", syncStatus: "synced", analytics: { views: 12 } }],
    });
    expect(a.perTarget).toEqual([{ platform: "youtube", views: 12 }]);
  });

  it("a per-target row still syncing keeps the post pending, whatever the top level says", () => {
    const a = toAnalytics("p1", {
      syncStatus: "synced",
      platformAnalytics: [{ platform: "instagram", syncStatus: "pending", analytics: { views: 0 } }],
    });
    expect(a.syncStatus).toBe("pending");
  });

  it("analytics pending fixture (a body-level pending, not just an HTTP 202) still syncs as pending, never zeros", () => {
    const a = toAnalytics("post_partial_1", analyticsPending);
    expect(a.syncStatus).toBe("pending");
    expect(a.perTarget).toEqual([]);
  });

  it("campaign status arrives UPPERCASE and is lower-cased to match the open union", () => {
    const [active, paused] = (campaigns as unknown[]).map(toCampaign);
    expect(active.status).toBe("active");
    expect(active.budget).toEqual({ amount: 10, type: "daily", currency: "USD" });
    expect(active.reviewStatus).toBe("approved");
    expect(paused.status).toBe("paused");
    expect(paused.budget).toEqual({ amount: 5, type: "lifetime", currency: "USD" });
    expect(paused.reviewStatus).toBe("rejected");
  });

  it("ad account maps connected from isActive/status", () => {
    expect(toAdAccount({ _id: "act_1", network: "meta", name: "Nagel Labs Ads", currency: "USD", isActive: true })).toMatchObject({
      id: "act_1",
      network: "meta",
      name: "Nagel Labs Ads",
      currency: "USD",
      connected: true,
    });
    expect(toAdAccount({ _id: "act_2", status: "disconnected" }).connected).toBe(false);
  });

  it("create body: SNAKE_CASE top level, camelCase inside platforms[], stamp, tags, AI labels", () => {
    const body = toCreateBody({
      requestId: "r1", content: "hi", media: [{ url: "https://cdn/x.mp4", type: "video" }],
      targets: [
        { platform: "instagram", accountId: "ig", options: { platform: "instagram", instagram: { contentType: "story" } } },
        { platform: "tiktok", accountId: "tt", options: { platform: "tiktok", tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: false, allowDuet: false, allowStitch: false, commercialContentType: "none", contentPreviewConfirmed: true, expressConsentGiven: true } } },
      ],
      when: { mode: "draft" }, libi: { pieceId: "piece_1" },
    }, true);
    expect(body).toMatchObject({
      content: "hi", is_draft: true, tags: ["libi"],
      // The requestId is stamped INTO metadata: there is no header slot on the
      // live tool, so this is the only idempotency key that reaches the post.
      metadata: { libi: { pieceId: "piece_1", requestId: "r1" } },
      media_items: [{ type: "video", url: "https://cdn/x.mp4" }],
      platforms: [{ platform: "instagram", accountId: "ig", platformSpecificData: { contentType: "story", isAiGenerated: true } }, { platform: "tiktok", accountId: "tt" }],
      tiktok_settings: { privacy_level: "PUBLIC_TO_EVERYONE", allow_comment: false, allow_duet: false, allow_stitch: false, video_made_with_ai: true, content_preview_confirmed: true, express_consent_given: true, commercialContentType: "none" },
    });
    // The live tool is `additionalProperties: false`: a camelCase key at the
    // TOP level does not get ignored, it fails the whole call.
    // Every target's chosen options ride along in metadata.libi, keyed by
    // nothing but position — this is what lets a reopened draft restore its
    // TikTok settings even though Zernio never echoes `tiktok_settings` back.
    expect((body.metadata as { libi: { targetOptions: unknown } }).libi.targetOptions).toEqual([
      { platform: "instagram", instagram: { contentType: "story" } },
      { platform: "tiktok", tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: false, allowDuet: false, allowStitch: false, commercialContentType: "none", contentPreviewConfirmed: true, expressConsentGiven: true } },
    ]);
    for (const camel of ["isDraft", "mediaItems", "tiktokSettings", "scheduledFor", "publishNow", "dryRun", "headers"]) {
      expect(body).not.toHaveProperty(camel);
    }
    const sched = toCreateBody({ requestId: "r", content: "", media: [], targets: [], when: { mode: "schedule", scheduledFor: "2026-10-01T09:00:00", timezone: "Asia/Bangkok" }, libi: { pieceId: "p" } }, false);
    expect(sched).toMatchObject({ is_draft: false, scheduled_for: "2026-10-01T09:00:00", timezone: "Asia/Bangkok" });
    const now = toCreateBody({ requestId: "r", content: "", media: [], targets: [], when: { mode: "now" }, libi: { pieceId: "p" } }, false);
    expect(now).toMatchObject({ is_draft: false, publish_now: true });
  });

  /**
   * QA finding 3: the Targets step hides the "share to feed" switch for a
   * Story (it only means anything for a Reel), but the composer's local
   * state can still be carrying `shareToFeed: true` from before the content
   * type was switched — and until now `toCreateBody` sent it verbatim, so a
   * live Story published with `platformSpecificData: {contentType: "story",
   * shareToFeed: true}` and the detail sheet echoed it back as "Story ·
   * share to feed", describing something that never happened.
   */
  it("create body drops shareToFeed for a Story (and a Feed post) even when the caller's options still carry it", () => {
    const targetsWith = (contentType: "story" | "feed" | "reel") => [
      { platform: "instagram" as const, accountId: "ig", options: { platform: "instagram" as const, instagram: { contentType, shareToFeed: true } } },
    ];
    const story = toCreateBody({ requestId: "r", content: "", media: [], targets: targetsWith("story"), when: { mode: "draft" }, libi: { pieceId: "p" } }, true);
    const feed = toCreateBody({ requestId: "r", content: "", media: [], targets: targetsWith("feed"), when: { mode: "draft" }, libi: { pieceId: "p" } }, true);
    const reel = toCreateBody({ requestId: "r", content: "", media: [], targets: targetsWith("reel"), when: { mode: "draft" }, libi: { pieceId: "p" } }, true);
    const platformsOf = (b: Record<string, unknown>) => (b.platforms as Array<{ platformSpecificData: Record<string, unknown> }>)[0].platformSpecificData;
    expect(platformsOf(story)).not.toHaveProperty("shareToFeed");
    expect(platformsOf(feed)).not.toHaveProperty("shareToFeed");
    // A Reel is the one content type it's real for — still sent there.
    expect(platformsOf(reel)).toHaveProperty("shareToFeed", true);
  });

  it("update body: snake_case too, and it never rewrites the post's metadata unless the caller supplies libi", () => {
    expect(toUpdateBody({ requestId: "r", when: { mode: "cancel" } })).toEqual({ is_draft: true });
    expect(toUpdateBody({ requestId: "r", when: { mode: "now" } })).toEqual({ is_draft: false, publish_now: true });
    // No `libi` on the patch: writing one from nothing would REPLACE the
    // post's metadata.libi and lose the pieceId and requestId stored there.
    expect(toUpdateBody({ requestId: "r", content: "x" })).not.toHaveProperty("metadata");
  });

  it("update body extends the caller's existing metadata.libi with targetOptions derived from targets — never replaces it", () => {
    const tiktokOptions = { platform: "tiktok" as const, tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true, allowDuet: true, allowStitch: true, commercialContentType: "none" as const, contentPreviewConfirmed: true as const, expressConsentGiven: true as const } };
    const body = toUpdateBody({
      requestId: "r",
      targets: [{ platform: "tiktok", accountId: "tt", options: tiktokOptions }],
      libi: { pieceId: "piece_1", requestId: "r1", exportFile: "export.mp4" },
    });
    expect(body.metadata).toEqual({
      libi: { pieceId: "piece_1", requestId: "r1", exportFile: "export.mp4", targetOptions: [tiktokOptions] },
    });
  });

  it("update body re-sends media_items, and stamps that URL as the one to reuse", () => {
    // Measured live 2026-09-20: attaching promotes `temp/` -> `media/`, the
    // promoted URL 404s, re-sending it fails the whole call, and OMITTING
    // `media_items` fails identically. So an update carries the original.
    const media = [{ url: "https://media.zernio.test/temp/1_e.mp4", type: "video" as const, filename: "e.mp4", sizeBytes: 1210131, mimeType: "video/mp4" }];
    const body = toUpdateBody({ requestId: "r", media, libi: { pieceId: "piece_1", requestId: "r1" } });
    expect(body.media_items).toEqual([{ type: "video", url: media[0].url, filename: "e.mp4", size: 1210131, mimeType: "video/mp4" }]);
    expect(body.metadata).toEqual({ libi: { pieceId: "piece_1", requestId: "r1", mediaUrl: media[0].url } });
    // A patch with no media says nothing about media — it does not blank it.
    expect(toUpdateBody({ requestId: "r", content: "x" })).not.toHaveProperty("media_items");
  });

  it("create body stamps the sent media URL and sends TikTok's consents from the OPTIONS, never as a constant", () => {
    const tiktok = {
      platform: "tiktok" as const,
      tiktok: {
        privacyLevel: "PUBLIC_TO_EVERYONE",
        allowComment: true,
        allowDuet: false,
        allowStitch: false,
        commercialContentType: "none" as const,
        contentPreviewConfirmed: false,
        expressConsentGiven: false,
      },
    };
    const body = toCreateBody(
      {
        requestId: "r",
        content: "c",
        media: [{ url: "https://media.zernio.test/temp/1_e.mp4", type: "video" }],
        targets: [{ platform: "tiktok", accountId: "tt", options: tiktok }],
        when: { mode: "draft" },
        libi: { pieceId: "p" },
      },
      true,
    );
    expect((body.metadata as { libi: { mediaUrl?: string } }).libi.mediaUrl).toBe("https://media.zernio.test/temp/1_e.mp4");
    // An unconsented target must not be dressed up as a consented one on the
    // wire; the write routes then refuse it (`z.literal(true)`).
    expect(body.tiktok_settings).toMatchObject({ content_preview_confirmed: false, express_consent_given: false });
  });

  it("update body writes libi metadata with no targetOptions when no targets are in the patch", () => {
    const body = toUpdateBody({ requestId: "r", content: "x", libi: { pieceId: "piece_1", requestId: "r1" } });
    expect(body.metadata).toEqual({ libi: { pieceId: "piece_1", requestId: "r1" } });
  });

  it("a TikTok dry run is not a post — it normalizes to its own verdict shape", () => {
    expect(toDryRun({ dryRun: true, canPublish: false, tiktok: [{ accountId: "tt", canPublish: false, reason: "daily limit reached" }] })).toEqual({
      canPublish: false,
      perAccount: [{ accountId: "tt", canPublish: false, reason: "daily limit reached" }],
    });
    // Nothing invented when the provider sent no rows at all.
    expect(toDryRun({})).toEqual({ canPublish: false, perAccount: [] });
  });

  it("reads requestId back off a post's metadata", () => {
    expect(toPost({ _id: "p1", metadata: { libi: { pieceId: "piece_1", requestId: "r1" } } }).libi).toMatchObject({ pieceId: "piece_1", requestId: "r1" });
    // A post with a requestId but no pieceId is still recognizably libi's.
    expect(toPost({ _id: "p2", metadata: { libi: { requestId: "r2" } } }).libi?.requestId).toBe("r2");
    expect(toPost({ _id: "p3", metadata: {} }).libi).toBeUndefined();
  });

  it("restores targetOptions off metadata.libi — the TikTok settings round trip", () => {
    const tiktokOptions = { platform: "tiktok", tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true, allowDuet: false, allowStitch: false, commercialContentType: "none", contentPreviewConfirmed: true, expressConsentGiven: true } };
    const post = toPost({ _id: "p1", metadata: { libi: { pieceId: "piece_1", requestId: "r1", targetOptions: [tiktokOptions] } } });
    expect(post.libi?.targetOptions).toEqual([tiktokOptions]);
  });

  it("never restores targetOptions that are missing or not shaped like TargetOptions[] — the composer must ask again, not assume consent", () => {
    // Missing entirely.
    expect(toPost({ _id: "p1", metadata: { libi: { pieceId: "piece_1" } } }).libi?.targetOptions).toBeUndefined();
    // Not an array at all.
    expect(toPost({ _id: "p2", metadata: { libi: { pieceId: "piece_1", targetOptions: "nope" } } }).libi?.targetOptions).toBeUndefined();
    // An array of garbage — no recognizable platform/options shape.
    expect(toPost({ _id: "p3", metadata: { libi: { pieceId: "piece_1", targetOptions: [{ foo: "bar" }] } } }).libi?.targetOptions).toBeUndefined();
    // A tiktok entry with no actual tiktok settings block.
    expect(toPost({ _id: "p4", metadata: { libi: { pieceId: "piece_1", targetOptions: [{ platform: "tiktok" }] } } }).libi?.targetOptions).toBeUndefined();
  });
});
