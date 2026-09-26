import type { FakeState, Row } from "./state";

/**
 * A worked example of a piece that has done EVERYTHING on social, for looking
 * at the UI with real-shaped data instead of one lonely post.
 *
 * Test-mode only, and reached by `seed: "qa"` in the fake's config — nothing
 * here is ever served by the real provider. The post rows follow the shapes
 * `.superpowers/sdd/zernio-live-shapes.md` records as verified; the AD rows do
 * not, because no ads account has ever been connected, so they follow
 * `ad_campaigns_list_ads`'s documented filter names and the ad-analytics
 * fields the docs list, and should be treated as a placeholder that exercises
 * the seam rather than as recorded truth.
 *
 * Ids are fixed strings so a seeding script can link them to a piece without
 * reading anything back.
 */

const IG = "6aae6b468d284ffb211ade1e";
const TT = "6aae6ba98d284ffb211ae03a";
const FB = "6aae6b468d284ffb211ade40";
const X = "6aae6b468d284ffb211ade41";
const YT = "6aae6b468d284ffb211ade42";

/** The three platforms libi's own composer does not build for yet. Seeded so
 *  the "agent only" treatment can actually be seen. */
export const QA_EXTRA_ACCOUNTS: Row[] = [
  {
    _id: FB, platform: "facebook", username: "nagellabs", displayName: "Nagel Labs",
    profileUrl: "https://facebook.com/nagellabs", isActive: true, enabled: true, needsReconnection: false,
    platformStatus: "active", followersCount: 812, adsStatus: "connected",
    profileId: { _id: "6aae6a1e8d284ffb211adc02", name: "Nagel Labs" },
  },
  {
    _id: X, platform: "twitter", username: "nagellabs", displayName: "Nagel Labs",
    profileUrl: "https://x.com/nagellabs", isActive: true, enabled: true, needsReconnection: false,
    platformStatus: "active", followersCount: 2431, adsStatus: "not_connected",
    profileId: { _id: "6aae6a1e8d284ffb211adc02", name: "Nagel Labs" },
  },
  {
    _id: YT, platform: "youtube", username: "nagellabs", displayName: "Nagel Labs",
    profileUrl: "https://youtube.com/@nagellabs", isActive: true, enabled: true, needsReconnection: false,
    platformStatus: "active", followersCount: 604, adsStatus: "not_connected",
    profileId: { _id: "6aae6a1e8d284ffb211adc02", name: "Nagel Labs" },
  },
];

const MEDIA = [{ type: "video", url: "https://media.zernio.com/temp/qa-desk-setup.mp4", thumbnail: "https://media.zernio.com/temp/qa-desk-setup.jpg" }];

const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

function platformRow(accountId: string, platform: string, over: Row = {}): Row {
  return { platform, accountId, status: "published", ...over };
}

/**
 * Every post the QA piece has. One per supported content type, plus one per
 * status the UI renders differently — a list where everything is `published`
 * proves nothing about the chips, the filters or the attention list.
 */
export const QA_POSTS: Row[] = [
  {
    _id: "qa_post_reel", status: "published", content: "The desk setup that finally works.\n\n#studio #desksetup",
    mediaItems: MEDIA, scheduledFor: days(-6), publishedAt: days(-6), timezone: "Asia/Bangkok", tags: ["libi"],
    platforms: [platformRow(IG, "instagram", { platformPostId: "17900000000000001", platformPostUrl: "https://www.instagram.com/reel/QAreel1/", platformSpecificData: { contentType: "reel", shareToFeed: true, commentsEnabled: true, isAiGenerated: true } })],
    metadata: { libi: { pieceId: "QA_PIECE_ID", appVersion: "0.1.16" } }, createdAt: days(-6),
  },
  {
    _id: "qa_post_feed", status: "published", content: "Three lenses, one shot list. Swipe for the grid.",
    mediaItems: MEDIA, scheduledFor: days(-4), publishedAt: days(-4), timezone: "Asia/Bangkok", tags: ["libi"],
    platforms: [platformRow(IG, "instagram", { platformPostId: "17900000000000002", platformPostUrl: "https://www.instagram.com/p/QAfeed1/", platformSpecificData: { contentType: "feed", shareToFeed: true, commentsEnabled: true, isAiGenerated: true } })],
    metadata: { libi: { pieceId: "QA_PIECE_ID" } }, createdAt: days(-4),
  },
  {
    _id: "qa_post_story", status: "published", content: "",
    mediaItems: MEDIA, scheduledFor: hours(-5), publishedAt: hours(-5), timezone: "Asia/Bangkok", tags: ["libi"],
    platforms: [platformRow(IG, "instagram", { platformPostId: "17900000000000003", platformSpecificData: { contentType: "story", isAiGenerated: true } })],
    metadata: { libi: { pieceId: "QA_PIECE_ID" } }, createdAt: hours(-5),
  },
  {
    _id: "qa_post_tiktok", status: "published", content: "Every layer is still editable. That's the whole point.",
    mediaItems: MEDIA, scheduledFor: days(-3), publishedAt: days(-3), timezone: "Asia/Bangkok", tags: ["libi"],
    platforms: [platformRow(TT, "tiktok", { platformPostId: "tt_7300000000000000001", platformPostUrl: "https://www.tiktok.com/@nagellabs/video/7300000000000000001" })],
    tiktokSettings: { privacy_level: "PUBLIC_TO_EVERYONE", allow_comment: true, allow_duet: true, allow_stitch: true, video_made_with_ai: true },
    metadata: { libi: { pieceId: "QA_PIECE_ID" } }, createdAt: days(-3),
  },
  // The three platforms libi's composer does not build for: posted by the
  // AGENT through the provider's own tools, and still listed here.
  {
    _id: "qa_post_facebook", status: "published", content: "Full build breakdown on the page.",
    mediaItems: MEDIA, scheduledFor: days(-5), publishedAt: days(-5), timezone: "Asia/Bangkok", tags: ["libi"],
    platforms: [platformRow(FB, "facebook", { platformPostId: "1122334455_9988776655", platformPostUrl: "https://facebook.com/nagellabs/posts/9988776655" })],
    metadata: { libi: { pieceId: "QA_PIECE_ID" } }, createdAt: days(-5),
  },
  {
    _id: "qa_post_x", status: "published", content: "One prompt in, a 36-second launch film out.",
    mediaItems: MEDIA, scheduledFor: days(-2), publishedAt: days(-2), timezone: "Asia/Bangkok", tags: ["libi"],
    platforms: [platformRow(X, "twitter", { platformPostId: "1850000000000000001", platformPostUrl: "https://x.com/nagellabs/status/1850000000000000001" })],
    metadata: { libi: { pieceId: "QA_PIECE_ID" } }, createdAt: days(-2),
  },
  {
    _id: "qa_post_youtube", status: "published", content: "Desk setup — the long cut",
    title: "Desk setup — the long cut", mediaItems: MEDIA, scheduledFor: days(-1), publishedAt: days(-1),
    timezone: "Asia/Bangkok", tags: ["libi"],
    platforms: [platformRow(YT, "youtube", { platformPostId: "dQw4w9WgXcQ", platformPostUrl: "https://youtube.com/watch?v=dQw4w9WgXcQ" })],
    metadata: { libi: { pieceId: "QA_PIECE_ID" } }, createdAt: days(-1),
  },
  // Every other status the row renders differently.
  {
    _id: "qa_post_scheduled", status: "scheduled", content: "Saturday drop: the colour grade breakdown.",
    mediaItems: MEDIA, scheduledFor: days(3), timezone: "Asia/Bangkok", tags: ["libi"],
    platforms: [
      platformRow(IG, "instagram", { status: "pending", scheduledFor: days(3), platformSpecificData: { contentType: "reel", shareToFeed: true, commentsEnabled: true } }),
      platformRow(TT, "tiktok", { status: "pending", scheduledFor: days(3) }),
    ],
    tiktokSettings: { privacy_level: "PUBLIC_TO_EVERYONE", allow_comment: true, allow_duet: true, allow_stitch: true },
    metadata: { libi: { pieceId: "QA_PIECE_ID" } }, createdAt: days(-1),
  },
  {
    _id: "qa_post_draft", status: "draft", content: "",
    mediaItems: MEDIA, scheduledFor: hours(1), timezone: "Asia/Bangkok", tags: ["libi"],
    platforms: [platformRow(IG, "instagram", { status: "pending", scheduledFor: hours(1), platformSpecificData: { contentType: "reel" } })],
    metadata: { libi: { pieceId: "QA_PIECE_ID" } }, createdAt: hours(-2),
  },
  {
    // Partial: Instagram went out, TikTok did not. The chip must show BOTH,
    // and the failure's own words must survive to the target chip's title.
    _id: "qa_post_partial", status: "partial", content: "Behind the shot — part two.",
    mediaItems: MEDIA, scheduledFor: days(-2), publishedAt: days(-2), timezone: "Asia/Bangkok", tags: ["libi"],
    platforms: [
      platformRow(IG, "instagram", { platformPostId: "17900000000000009", platformPostUrl: "https://www.instagram.com/reel/QAreel9/", platformSpecificData: { contentType: "reel" } }),
      platformRow(TT, "tiktok", { status: "failed", errorMessage: "TikTok rejected this video: it failed automated content review." }),
    ],
    metadata: { libi: { pieceId: "QA_PIECE_ID" } }, createdAt: days(-2),
  },
];

/**
 * Ads. Two boost a post — matched by the SAME id that post's target carries as
 * `platformPostId`, which is the whole mechanism — and one never was a post at
 * all, which is the case that needs a link row in libi's own table.
 */
export const QA_ADS: Row[] = [
  {
    _id: "qa_ad_boost_reel", platformAdId: "238000000000001", network: "metaads", name: "Desk setup — reel boost",
    status: "ACTIVE", campaignId: "camp_1", campaignName: "Desk setup — launch", adSetId: "adset_1",
    adAccountId: "act_1234", currency: "USD",
    effectiveInstagramMediaId: "17900000000000001",
    createdAt: days(-5),
    metrics: { spend: 42.18, impressions: 18400, reach: 14120, clicks: 391, ctr: 2.12, cpc: 0.11, cpm: 2.29 },
  },
  {
    _id: "qa_ad_boost_fb", platformAdId: "238000000000002", network: "metaads", name: "Build breakdown — page boost",
    status: "PAUSED", campaignId: "camp_2", campaignName: "Retarget — watchers", adAccountId: "act_1234", currency: "USD",
    effectiveObjectStoryId: "1122334455_9988776655",
    createdAt: days(-4),
    metrics: { spend: 7.4, impressions: 2210, reach: 1980, clicks: 24, ctr: 1.09, cpc: 0.31, cpm: 3.35 },
  },
  {
    // Never an organic post: made straight as an ad. Nothing on the provider
    // ties it to a piece, so libi's own `social_ad_links` row is the only way
    // it can appear on the Posting tab.
    _id: "qa_ad_dark", platformAdId: "238000000000003", network: "metaads", name: "Studio launch — dark post",
    status: "ACTIVE", campaignId: "camp_1", campaignName: "Desk setup — launch", adAccountId: "act_1234", currency: "USD",
    createdAt: days(-3),
    metrics: { spend: 118.92, impressions: 54300, reach: 39100, clicks: 1204, ctr: 2.22, cpc: 0.1, cpm: 2.19 },
  },
];

/** Put the QA fixture into a fresh fake state, replacing the piece-id stamp. */
export function applyQaSeed(state: FakeState, pieceId: string): void {
  state.accounts = [...state.accounts, ...QA_EXTRA_ACCOUNTS];
  for (const p of QA_POSTS) {
    const stamped = JSON.parse(JSON.stringify(p).replaceAll("QA_PIECE_ID", pieceId)) as Row;
    state.posts.set(String(stamped._id), stamped);
  }
  for (const a of QA_ADS) state.ads.set(String(a._id), a);
}
