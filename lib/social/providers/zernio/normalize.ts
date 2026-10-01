/**
 * Pure mappers from Zernio's raw MCP tool output to libi's normalized
 * entities, plus the two REST-body builders `posts_create_post` /
 * `posts_update_post` expect. No network, no logging, no side effects —
 * fixture-tested (`fixtures/*.json`, `__tests__/unit/social/zernio-normalize.test.ts`).
 *
 * Ground truth is the spec appendix (verified live against Zernio on
 * 2026-09-20) plus the task-8 brief's live `accounts.list` Instagram row
 * (also verified 2026-09-20 — see `toAccount` and `fixtures/account.json`).
 * Where a field's exact spelling was NOT in either verified source, this
 * file accepts both camelCase and snake_case rather than guessing one.
 *
 * Stage-A checklist — fields still NOT verified against the live server,
 * confirm before trusting them:
 *  - `toAnalytics`: the LIVE shape (per-platform metrics nested under
 *    `platforms[].analytics`, with `syncStatus`) is verified and handled
 *    first; the older `platformAnalytics` / `platform_analytics` / `data`
 *    wrapper keys behind it are guesses kept for a server that answers a
 *    flat per-target array instead.
 *  - `toCampaign`: every field except the lower-cased `status` casing rule —
 *    `adAccountId`, `network`, `status` itself, `reviewStatus`, `objective`,
 *    `budgetAmount`/`budgetType`/`currency`, `startDate`, `endDate`,
 *    `existingPostId`, and the `metrics`/`insights` wrapper with its
 *    `spend`/`impressions`/`clicks`/`ctr`/`cpc`/`cpm`.
 *  - `toAdAccount`: every field (`network`, `name`, `currency`,
 *    `isActive`/`status`) — no raw shape for ad accounts was verified at all.
 * `toAccount`'s own row shape is now verified (task-8 brief); its remaining
 * camel/snake fallbacks (`display_name`, `profile_url`, `is_active`) are
 * defensive only, not open questions.
 */
import type {
  SocialAccount,
  SocialPost,
  SocialTarget,
  TargetOptions,
  PostAnalytics,
  TikTokCreatorInfo,
  SocialAdCampaign,
  SocialAd,
  SocialAdAccount,
  TikTokDryRun,
  CreatePostInput,
  UpdatePostInput,
  PostStatus,
  TargetStatus,
  StoryInsights,
} from "@/lib/social/types";
import { isComposablePlatform } from "@/lib/social/catalog";
import type { KnownPlatform } from "@/lib/social/catalog";
import type { CatalogTrack } from "@/lib/social/music-policy";

type R = Record<string, unknown>;
const rec = (v: unknown): R => (v && typeof v === "object" ? (v as R) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const id = (r: R): string => str(r._id) ?? str(r.id) ?? "";
/** A catalog id: a string, or a number (Python-repr envelopes and some
 *  platforms send ids as numbers) kept as its decimal string. */
const idText = (v: unknown): string | undefined => str(v) ?? (num(v) !== undefined ? String(v) : undefined);

const POST_STATUSES: PostStatus[] = ["draft", "scheduled", "publishing", "published", "partial", "failed", "cancelled"];
/**
 * The provider's own platform key, passed through verbatim. Deliberately NOT
 * narrowed to the two libi's composer builds for: the agent posts to the
 * others through the same account, and those rows still have to appear in
 * libi's lists under their own name. The old shape mapped anything
 * unrecognized to `"instagram"`, which would have labelled a YouTube
 * analytics row as Instagram; `platformLabel` handles a key this build has
 * never seen. A row carrying no platform at all keeps the old default.
 */
const platformOf = (v: unknown): KnownPlatform => (typeof v === "string" && v ? (v as KnownPlatform) : "instagram");

/**
 * The `accounts.list` row itself is now verified (task-8 brief, live
 * Instagram row, 2026-09-20) — camel/snake acceptance below is defensive,
 * not an open question. That row also carries `tokenExpiresAt` and
 * `needsReconnection` directly, so `health` is synthesized right here
 * instead of leaving the dashboard to wait for a separate `toHealth` call —
 * see `accountHealthFromRow`.
 */
export function toAccount(raw: unknown): SocialAccount {
  const r = rec(raw);
  const profile = rec(r.profileId);
  return {
    id: id(r),
    platform: platformOf(r.platform),
    username: str(r.username) ?? "",
    displayName: str(r.displayName) ?? str(r.display_name) ?? str(r.username) ?? "",
    profileUrl: str(r.profileUrl) ?? str(r.profile_url),
    active: r.isActive !== false && r.is_active !== false,
    profileId: str(r.profileId) ?? str(profile._id),
    profileName: str(profile.name),
    health: accountHealthFromRow(r),
    externalPostCount: num(r.externalPostCount),
  };
}

/**
 * Synthesize `SocialAccount.health` straight from an `accounts.list` row's
 * own `tokenExpiresAt` / `needsReconnection` (both confirmed present on a
 * live row — task-8 brief), so the accounts list alone can drive "token
 * expires …" / "needs reconnect" UI without a second round trip to
 * `toHealth`. `undefined` when the row carries neither field — never invent
 * a status the row didn't send. Same `{ status, tokenExpiresAt }` shape as
 * `toHealth`'s return, so a caller that later fetches the richer
 * `accounts.health` result can merge it in without reconciling anything:
 * `{ ...toAccount(row).health, ...toHealth(richRaw) }` always lets the
 * richer result win.
 */
function accountHealthFromRow(r: R): SocialAccount["health"] {
  const tokenExpiresAt = str(r.tokenExpiresAt);
  const needsReconnection = typeof r.needsReconnection === "boolean" ? r.needsReconnection : undefined;
  if (tokenExpiresAt === undefined && needsReconnection === undefined) return undefined;
  const status: "healthy" | "reconnect" | "unknown" = needsReconnection === true ? "reconnect" : needsReconnection === false ? "healthy" : "unknown";
  return { status, tokenExpiresAt };
}

/**
 * Account health — verified appendix shape:
 * `{ accountId, platform, username, displayName, status, tokenStatus:
 * { valid, expiresAt, expiresIn, needsRefresh }, permissions: {...},
 * issues[], recommendations[], messagingRestriction }`. Token expiry must
 * reach the UI, so `tokenStatus.valid` (a verified boolean) drives `status`
 * rather than the provider's own `status` string, whose exact values were
 * not printed in the appendix; `r.status` is only a fallback for a shape
 * `tokenStatus` didn't cover.
 */
export function toHealth(raw: unknown): SocialAccount["health"] {
  const r = rec(raw);
  const token = rec(r.tokenStatus ?? r.token_status ?? r.token);
  const status: "healthy" | "reconnect" | "unknown" =
    token.valid === true
      ? "healthy"
      : token.valid === false
        ? "reconnect"
        : r.status === "healthy"
          ? "healthy"
          : typeof r.status === "string" && r.status
            ? "reconnect"
            : "unknown";
  return { status, tokenExpiresAt: str(token.expiresAt) ?? str(token.expires_at) ?? str(r.tokenExpiresAt) };
}

/**
 * A platform row's `platformSpecificData` (Instagram) / the post's own
 * `tiktokSettings` (TikTok, shared across all TikTok targets on that post —
 * verified appendix shape) → the target's echoed `options`. Returns
 * `undefined` when the provider sent nothing to echo (e.g. a bare TikTok row
 * with no settings block), rather than inventing defaults.
 */
function targetOptions(platform: KnownPlatform, row: R, post: R): TargetOptions | undefined {
  // A target on a platform libi's composer does not build for (the agent's
  // Facebook or YouTube post) carries no options this type can hold — say so
  // rather than falling through to the TikTok branch below, which would read
  // a TikTok settings block that isn't there.
  if (!isComposablePlatform(platform)) return undefined;
  if (platform === "instagram") {
    const d = rec(row.platformSpecificData);
    if (!d.contentType) return undefined;
    return {
      platform,
      instagram: {
        contentType: d.contentType as "reel" | "feed" | "story",
        ...(d.shareToFeed !== undefined && { shareToFeed: !!d.shareToFeed }),
        ...(d.commentsEnabled !== undefined && { commentsEnabled: !!d.commentsEnabled }),
        ...(d.isAiGenerated !== undefined && { isAiGenerated: !!d.isAiGenerated }),
        ...(Array.isArray(d.collaborators) && { collaborators: d.collaborators as string[] }),
        ...(str(d.firstComment) && { firstComment: str(d.firstComment) }),
      },
    };
  }
  const t = rec(post.tiktokSettings);
  if (!t.privacy_level) return undefined;
  return {
    platform,
    tiktok: {
      privacyLevel: String(t.privacy_level),
      allowComment: !!t.allow_comment,
      allowDuet: !!t.allow_duet,
      allowStitch: !!t.allow_stitch,
      commercialContentType: (t.commercialContentType as "none" | "brand_organic" | "brand_content") ?? "none",
      madeWithAi: t.video_made_with_ai === true,
      coverTimestampMs: num(t.video_cover_timestamp_ms),
      contentPreviewConfirmed: true,
      expressConsentGiven: true,
    },
  };
}

/**
 * `metadata.libi.targetOptions` back off the wire, or `undefined` when it is
 * missing or not shaped like `TargetOptions[]`.
 *
 * The composer restores TikTok consent alongside these (`preview` +
 * `express`, both re-asked by default) ON THE STRENGTH of this value being
 * genuinely `TargetOptions` the user chose — so a value that merely LOOKS
 * present but is not properly shaped (a foreign `metadata.libi` write, a
 * future format change) must come back `undefined` rather than something
 * half-parsed, or a composer reopening the draft would treat garbage as the
 * user's own consent.
 */
function toStoredTargetOptions(raw: unknown): TargetOptions[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: TargetOptions[] = [];
  for (const item of raw) {
    const o = rec(item);
    if (o.platform === "instagram" && rec(o.instagram).contentType) out.push(o as unknown as TargetOptions);
    else if (o.platform === "tiktok" && rec(o.tiktok).privacyLevel) out.push(o as unknown as TargetOptions);
  }
  return out.length ? out : undefined;
}

export function toPost(raw: unknown): SocialPost {
  const r = rec(raw);
  const status = (POST_STATUSES as string[]).includes(String(r.status)) ? (r.status as PostStatus) : "draft";
  const targets: SocialTarget[] = (Array.isArray(r.platforms) ? r.platforms : []).map((p) => {
    const row = rec(p);
    // The verified invariant: a platform row's `accountId` is an OBJECT
    // ({ _id, platform, username, displayName, profilePicture, profileId,
    // isActive }), never a bare string — pull `_id` out of it, with a
    // string fallback only for a shape this normalizer has not seen live.
    const accountIdRaw = row.accountId;
    const accountId = typeof accountIdRaw === "string" ? accountIdRaw : id(rec(accountIdRaw));
    const platform = platformOf(row.platform);
    const ts: TargetStatus = ["pending", "published", "failed", "cancelled"].includes(String(row.status)) ? (row.status as TargetStatus) : "pending";
    return {
      platform,
      accountId,
      status: ts,
      platformPostId: str(row.platformPostId),
      url: str(row.platformPostUrl),
      error: str(row.errorMessage),
      options: targetOptions(platform, row, r),
    };
  });
  const libi = rec(rec(r.metadata).libi);
  return {
    id: id(r),
    status,
    content: str(r.content) ?? "",
    title: str(r.title),
    createdAt: str(r.createdAt) ?? new Date(0).toISOString(),
    // A DRAFT's platform rows still carry `scheduledFor` (roughly "now") and
    // `status: "pending"`, even though the post's own status is `draft` — that
    // time is meaningless and must never surface as a schedule. Only a
    // non-draft post's own top-level `scheduledFor` is real.
    scheduledFor: status === "draft" ? undefined : str(r.scheduledFor),
    timezone: str(r.timezone),
    publishedAt: str(r.publishedAt),
    media: (Array.isArray(r.mediaItems) ? r.mediaItems : []).map((m) => {
      const mr = rec(m);
      return { url: str(mr.url) ?? "", type: mr.type === "image" ? "image" : "video" as const };
    }),
    targets,
    tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
    // `requestId` is read back on its own: the recovery scan matches on it,
    // and a post whose `pieceId` was never stamped can still be recognized as
    // this request's own work.
    libi: str(libi.pieceId) || str(libi.requestId)
      ? {
          pieceId: String(libi.pieceId ?? ""),
          pieceName: str(libi.pieceName),
          exportFile: str(libi.exportFile),
          appVersion: str(libi.appVersion),
          requestId: str(libi.requestId),
          targetOptions: toStoredTargetOptions(libi.targetOptions),
          // The URL the upload produced. NOT `mediaItems[].url` — that one is
          // the promoted `media/` copy, which 404s and fails any update it is
          // re-sent on.
          mediaUrl: str(libi.mediaUrl),
        }
      : undefined,
  };
}

/**
 * A provider timestamp as ISO. The live analytics block spells `lastUpdated`
 * `"2026-09-19 11:00:24"` — space-separated, no zone (zernio-live-shapes.md) —
 * which `new Date()` reads as LOCAL time, silently shifting it by the viewer's
 * offset. Assume UTC and say so, rather than handing that string on.
 */
const isoTime = (v: unknown): string | undefined => {
  const s = str(v);
  if (!s) return undefined;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
};

/**
 * One platform row of the LIVE analytics shape (zernio-live-shapes.md,
 * verified 2026-09-20): `{ platform, status, platformPostId, accountId,
 * accountUsername, analytics: { impressions, reach, … }, syncStatus,
 * platformPostUrl, errorMessage }`. The metrics are NESTED under `analytics`,
 * not at the row's top level — reading them from the top level is how a post
 * with real numbers renders as all-blank.
 */
/**
 * `{data: {source, metrics: {...}}}` — verified live 2026-09-21 against a story
 * that was still up: `{'data': {'source': 'live', 'metrics': {'views': 0,
 * 'reach': 0, 'replies': 0, 'shares': 0, 'navigation': 0, 'tapsForward': 0,
 * 'tapsBack': 0, 'exits': 0, 'swipesForward': 0, 'profileVisits': 0,
 * 'follows': 0, 'reposts': 0, 'totalInteractions': 0}}}`.
 *
 * Zeros are REAL here and must be rendered as zeros, never as "no data":
 * Meta applies a privacy floor and reports any count below 5 as 0 on a small
 * audience, so a genuine 0 and a suppressed 3 are indistinguishable — which
 * the UI says out loud rather than guessing.
 *
 * An unrecognized `source` falls back to `unavailable`, the one value that
 * makes the UI stop waiting. Guessing `live` would leave it spinning forever,
 * which is the exact failure this whole path exists to end.
 */
export function toStoryInsights(raw: unknown): StoryInsights {
  const d = rec(rec(raw).data ?? raw);
  const m = rec(d.metrics);
  const source = d.source === "live" || d.source === "cached" ? d.source : "unavailable";
  return {
    source,
    metrics: {
      views: num(m.views),
      reach: num(m.reach),
      replies: num(m.replies),
      shares: num(m.shares),
      navigation: num(m.navigation),
      tapsForward: num(m.tapsForward ?? m.taps_forward),
      tapsBack: num(m.tapsBack ?? m.taps_back),
      exits: num(m.exits),
      swipesForward: num(m.swipesForward ?? m.swipes_forward),
      profileVisits: num(m.profileVisits ?? m.profile_visits),
      follows: num(m.follows),
      reposts: num(m.reposts),
      totalInteractions: num(m.totalInteractions ?? m.total_interactions),
    },
  };
}

function liveTargetRow(x: unknown): PostAnalytics["perTarget"][number] {
  const row = rec(x);
  // The metrics live one level down, under the row's own `analytics` — both
  // in the list shape and in the single-post one. A row without that block is
  // read flat, so a server that ever inlines them still normalizes.
  const a = row.analytics !== undefined ? rec(row.analytics) : row;
  return {
    platform: platformOf(row.platform),
    impressions: num(a.impressions),
    reach: num(a.reach),
    views: num(a.views),
    likes: num(a.likes),
    comments: num(a.comments),
    shares: num(a.shares),
    saves: num(a.saves),
    engagementRate: num(a.engagementRate),
  };
}

export function toAnalytics(postId: string, raw: unknown, httpStatus?: number): PostAnalytics {
  // A 202-style "not ready yet" response normalizes to the syncing state
  // rather than zeros, so the UI can say "syncing" instead of claiming zero
  // views (brief, "analytics-pending" fixture).
  if (httpStatus === 202) return { postId, syncStatus: "pending", perTarget: [] };
  const r = rec(raw);
  // The verified live rows: per-platform metrics nested under each row's own
  // `analytics`, with a per-row `syncStatus`. "Still syncing" is signalled by
  // that field and by `overview.dataStaleness` — NEVER by zero metrics.
  //
  // The array has TWO spellings, both read live on 2026-09-20: the page shape
  // (`analytics_get_analytics` with no `post_id`) calls it `platforms`, and
  // the single-post shape (with `post_id`) calls it `platformAnalytics` and
  // keys the post `postId` rather than `_id`. Only the first was handled, so
  // the second fell through to a branch that read the metrics off the row's
  // TOP level — and a Reel with 135 impressions normalized to a blank card
  // with every number missing.
  const rows = Array.isArray(r.platforms)
    ? r.platforms
    : Array.isArray(r.platformAnalytics)
      ? r.platformAnalytics
      : Array.isArray(r.platform_analytics)
        ? r.platform_analytics
        : Array.isArray(r.data)
          ? r.data
          : [r];
  const syncing = rows.some((x) => {
    const s = str(rec(x).syncStatus);
    return s !== undefined && s !== "synced";
  });
  const sync: PostAnalytics["syncStatus"] =
    r.syncStatus === "pending" || r.status === "pending" || syncing ? "pending" : httpStatus === 424 ? "failed" : "ready";
  return {
    postId,
    syncStatus: sync,
    lastUpdated: isoTime(r.lastUpdated) ?? isoTime(rec(r.analytics).lastUpdated),
    perTarget: rows.map(liveTargetRow),
  };
}

/**
 * TikTok creator info — verified appendix shape:
 * `{ creator: { nickname, avatarUrl, isVerified, canPostMore },
 * privacyLevels: [{ value, label }], postingLimits: { maxVideoDurationSec,
 * interactionSettings: { allow_comment|allow_duet|allow_stitch: { enabled,
 * required, default, label } } }, commercialContentTypes: [{ value, label,
 * requires? }] }` — no `data` wrapper, `privacyLevels` items are `{value,
 * label}` objects, and the limit/interaction fields live under
 * `postingLimits`. `data`-wrapped / flat-string / snake_case variants are
 * accepted defensively in case a different tool or API version answers
 * differently, but the verified shape above is what drives every field.
 */
export function toCreatorInfo(accountId: string, raw: unknown): TikTokCreatorInfo {
  const r = rec(raw);
  const d = rec(r.data ?? r);
  const creator = rec(d.creator);
  const postingLimits = rec(d.postingLimits ?? d.posting_limits);
  const interactionSettings = rec(postingLimits.interactionSettings ?? postingLimits.interaction_settings ?? d.interactions);
  // Render only what the provider returned — never a hardcoded list.
  const levels = (Array.isArray(d.privacyLevels) ? d.privacyLevels : Array.isArray(d.privacy_level_options) ? d.privacy_level_options : [])
    .map((v) => (v && typeof v === "object" ? str((v as R).value) : str(v)))
    .filter((v): v is string => !!v);
  const inter = (k: string) => {
    const i = rec(interactionSettings[k] ?? d[k]);
    // Measured live (2026-09-21): `{enabled: true, required: true, default: false,
    // label: 'Allow Comment'}`. `enabled` was being dropped, which is the only
    // one of the three that decides whether the switch may be on at all.
    return { enabled: i.enabled !== false, required: i.required !== false, default: i.default === true };
  };
  return {
    accountId,
    privacyLevels: levels,
    maxVideoSeconds:
      num(postingLimits.maxVideoDurationSec) ?? num(postingLimits.max_video_duration_sec) ?? num(d.maxVideoPostDurationSec) ?? num(d.max_video_post_duration_sec) ?? 600,
    canPostMore: creator.canPostMore !== false && d.canPostMore !== false,
    interactions: {
      allow_comment: inter("allow_comment"),
      allow_duet: inter("allow_duet"),
      allow_stitch: inter("allow_stitch"),
    },
  };
}

// `status` is lower-cased here: the seam's other statuses are all lowercase
// and `SocialAdCampaign.status` is the open union "active" | "paused" |
// (string & {}) (types.ts). The UI title-cases it for display. That casing
// rule is the one verified fact about this raw shape (spec appendix); every
// other field name below is a guess from the brief and accepts camel/snake —
// verify at Task 23 stage A.
/**
 * One ad row. Shape UNVERIFIED against a live ads account, so every field is
 * read defensively in both casings and left `undefined` when absent — the UI
 * renders what arrived and nothing else. The two `effective*` ids are the
 * load-bearing ones: they are what ties an ad to the organic post it boosts,
 * and their spellings come from `ad_campaigns_list_ads`'s own documented
 * filter names rather than from a guess.
 */
export function toAd(raw: unknown): SocialAd {
  const r = rec(raw);
  const m = rec(r.metrics ?? r.insights);
  const creative = rec(r.creative);
  return {
    id: id(r),
    platformAdId: str(r.platformAdId) ?? str(r.platform_ad_id) ?? str(r.adId) ?? str(r.ad_id),
    network: str(r.network) ?? str(r.platform) ?? "metaads",
    name: str(r.name) ?? "",
    status: (str(r.status) ?? "unknown").toLowerCase(),
    campaignId: str(r.campaignId) ?? str(r.campaign_id),
    campaignName: str(r.campaignName) ?? str(r.campaign_name),
    adSetId: str(r.adSetId) ?? str(r.ad_set_id),
    adAccountId: str(r.adAccountId) ?? str(r.ad_account_id),
    effectiveInstagramMediaId:
      str(r.effectiveInstagramMediaId) ?? str(r.effective_instagram_media_id) ?? str(creative.effectiveInstagramMediaId) ?? str(creative.effective_instagram_media_id),
    effectiveObjectStoryId:
      str(r.effectiveObjectStoryId) ?? str(r.effective_object_story_id) ?? str(creative.effectiveObjectStoryId) ?? str(creative.effective_object_story_id),
    previewUrl: str(r.previewUrl) ?? str(r.preview_url) ?? str(creative.previewUrl),
    thumbnailUrl: str(r.thumbnailUrl) ?? str(r.thumbnail_url) ?? str(creative.thumbnailUrl) ?? str(creative.thumbnail_url),
    currency: str(r.currency),
    createdAt: str(r.createdAt) ?? str(r.created_at),
    metrics: {
      spend: num(m.spend),
      impressions: num(m.impressions),
      reach: num(m.reach),
      clicks: num(m.clicks),
      ctr: num(m.ctr),
      cpc: num(m.cpc),
      cpm: num(m.cpm),
    },
  };
}

export function toCampaign(raw: unknown): SocialAdCampaign {
  const r = rec(raw);
  const m = rec(r.metrics ?? r.insights);
  const budgetAmount = num(r.budgetAmount) ?? num(r.budget_amount);
  const budgetType = r.budgetType ?? r.budget_type;
  return {
    id: id(r),
    adAccountId: str(r.adAccountId) ?? str(r.ad_account_id) ?? "",
    network: str(r.network) ?? str(r.platform) ?? "meta",
    name: str(r.name) ?? "",
    status: (str(r.status) ?? "unknown").toLowerCase(),
    reviewStatus: str(r.reviewStatus) ?? str(r.review_status),
    objective: str(r.objective),
    budget: budgetAmount !== undefined ? { amount: budgetAmount, type: budgetType === "lifetime" ? "lifetime" : "daily", currency: str(r.currency) } : undefined,
    startDate: str(r.startDate) ?? str(r.start_date),
    endDate: str(r.endDate) ?? str(r.end_date),
    linkedPostId: str(r.existingPostId) ?? str(r.existing_post_id),
    metrics: { spend: num(m.spend), impressions: num(m.impressions), clicks: num(m.clicks), ctr: num(m.ctr), cpc: num(m.cpc), cpm: num(m.cpm) },
  };
}

// No verified raw shape for ad accounts at all — every field is a guess from
// the brief, camel/snake accepted throughout. Verify at Task 23 stage A.
export function toAdAccount(raw: unknown): SocialAdAccount {
  const r = rec(raw);
  return {
    id: id(r),
    network: str(r.network) ?? str(r.platform) ?? "meta",
    name: str(r.name) ?? id(r),
    currency: str(r.currency),
    connected: r.isActive !== false && r.is_active !== false && r.status !== "disconnected",
  };
}

/**
 * The `posts_create_post` body.
 *
 * **The top level is snake_case and the tool is `additionalProperties: false`**
 * — verified against the live tool schema on 2026-09-20. It accepts exactly:
 * `title`, `content`, `media_items`, `platforms`, `scheduled_for`,
 * `publish_now`, `is_draft`, `dry_run`, `timezone`, `tags`, `hashtags`,
 * `mentions`, `crossposting_enabled`, `metadata`, `tiktok_settings`,
 * `facebook_settings`, `recycling`, `queued_from_profile`, `queue_id`.
 * A camelCase key at this level is not ignored — the whole call is REJECTED
 * (`1 validation error … Unexpected keyword argument`) and no post is created.
 *
 * Only the TOP level. `platforms[]` and `media_items[]` are declared
 * `additionalProperties: true` free-form objects and carry the REST API's own
 * camelCase (`accountId`, `platformSpecificData`, `mimeType`), so renaming
 * inside them would break the opposite way.
 *
 * `metadata.libi.requestId` is the idempotency key. There is no header slot on
 * these tools, so this stamp plus the local intent row is the ONLY way a retry
 * can recognize its own earlier post (see `adapter.ts` → `createPost`).
 */
export function toMediaItems(media: CreatePostInput["media"]): Array<Record<string, unknown>> {
  return media.map((m) => ({
    type: m.type,
    url: m.url,
    ...(m.filename && { filename: m.filename }),
    ...(m.sizeBytes && { size: m.sizeBytes }),
    ...(m.mimeType && { mimeType: m.mimeType }),
  }));
}

export function toCreateBody(input: CreatePostInput, aiLabelDefault: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    content: input.content,
    media_items: toMediaItems(input.media),
    platforms: input.targets.map((t) => {
      if (t.options.platform === "instagram") {
        const o = t.options.instagram;
        return {
          platform: "instagram",
          accountId: t.accountId,
          platformSpecificData: {
            contentType: o.contentType,
            // `shareToFeed` only means anything for a Reel — the Targets
            // step (target-instagram.tsx) hides the switch for Feed/Story,
            // but the value stays in whatever `o` this call was handed, so
            // it has to be dropped HERE, at the one place the wire body is
            // built, or a Story ships `shareToFeed: true` and the detail
            // sheet echoes it back as "Story · share to feed" — describing
            // something that never happened (QA 2026-09-21, finding 3).
            ...(o.contentType === "reel" && o.shareToFeed !== undefined && { shareToFeed: o.shareToFeed }),
            ...(o.commentsEnabled !== undefined && { commentsEnabled: o.commentsEnabled }),
            isAiGenerated: o.isAiGenerated ?? aiLabelDefault,
            ...(o.collaborators?.length && { collaborators: o.collaborators }),
            ...(o.firstComment && { firstComment: o.firstComment }),
            // Spec §6.2: the platform's licensed copy, and the Reel's own audio name.
            ...(t.options.music?.mode === "attach" && {
              audioConfiguration: { audioId: t.options.music.track.id, audioVolume: t.options.music.musicVolume, videoVolume: t.options.music.originalVolume },
            }),
            ...(t.options.music?.soundName && { audioName: t.options.music.soundName }),
          },
        };
      }
      // Per-target tiktokSettings win over the root `tiktok_settings` (Zernio
      // "Platform fields"), so two TikTok accounts can get different music.
      // `musicSoundInfo` is ignored on a draft, which is why `draft` sends only that.
      const m = t.options.platform === "tiktok" ? t.options.music : undefined;
      const tts =
        m?.mode === "attach"
          ? {
              musicSoundInfo: {
                musicSoundId: m.track.id,
                musicSoundVolume: m.musicVolume,
                ...(m.startMs !== undefined && { musicSoundStart: m.startMs }),
                ...(m.endMs !== undefined && { musicSoundEnd: m.endMs }),
              },
              videoOriginalSoundVolume: m.originalVolume,
            }
          : m?.mode === "draft"
            ? { draft: true }
            : null;
      return { platform: "tiktok", accountId: t.accountId, ...(tts ? { platformSpecificData: { tiktokSettings: tts } } : {}) };
    }),
    tags: ["libi"],
    // `targetOptions` is stamped alongside the rest of `metadata.libi` so a
    // reopened draft can restore what the user chose per target — Zernio
    // echoes Instagram's `platformSpecificData` back fine but never
    // `tiktok_settings` (verified live, 2026-09-20), and this is the only
    // place that survives the round trip for it.
    // `mediaUrl` is stamped from the media being SENT — the upload's own
    // `temp/` URL. Attaching promotes it to `media/`, and that promoted URL
    // 404s, so the copy read back off the post can never be re-sent; this
    // stamp is the only record of the URL that still works (verified live
    // 2026-09-20, see `types.ts` -> `SocialPost.libi`).
    metadata: {
      libi: {
        ...input.libi,
        requestId: input.requestId,
        targetOptions: input.targets.map((t) => t.options),
        ...(input.media[0]?.url ? { mediaUrl: input.media[0].url } : {}),
      },
    },
  };
  const tt = input.targets.find((t) => t.options.platform === "tiktok")?.options;
  if (tt && tt.platform === "tiktok") {
    const o = tt.tiktok;
    body.tiktok_settings = {
      privacy_level: o.privacyLevel,
      allow_comment: o.allowComment,
      allow_duet: o.allowDuet,
      allow_stitch: o.allowStitch,
      commercialContentType: o.commercialContentType,
      video_made_with_ai: o.madeWithAi ?? aiLabelDefault,
      ...(o.coverTimestampMs !== undefined && { video_cover_timestamp_ms: o.coverTimestampMs }),
      // From the OPTIONS, never a constant: these are TikTok's two mandatory
      // consents and the only thing that makes them true is the user having
      // ticked both boxes. The write routes declare them `z.literal(true)`, so
      // a target that got here without them is refused at the boundary rather
      // than sent as consented.
      content_preview_confirmed: o.contentPreviewConfirmed,
      express_consent_given: o.expressConsentGiven,
    };
  }
  if (input.when.mode === "draft") body.is_draft = true;
  else if (input.when.mode === "schedule") {
    body.is_draft = false;
    body.scheduled_for = input.when.scheduledFor;
    body.timezone = input.when.timezone;
  } else {
    body.is_draft = false;
    body.publish_now = true;
  }
  return body;
}

/**
 * The `validate_post` body — `content`, `media_items` and `platforms`, and
 * NOTHING else.
 *
 * Its schema is `additionalProperties: false` like every other generated tool
 * (read off the live `tools/list`, 2026-09-20) and it accepts only those
 * three. Handing it a whole create body — which is what this did until the
 * strict fake refused it — fails the call outright with
 * `tags  Unexpected keyword argument`, so validation never ran at all.
 */
export function toValidateBody(input: CreatePostInput, aiLabelDefault: boolean): Record<string, unknown> {
  const { content, media_items, platforms } = toCreateBody(input, aiLabelDefault);
  return { content, media_items, platforms };
}

/**
 * The `posts_update_post` body. Same snake_case top level and the same
 * `additionalProperties: false`, with two differences from create, both
 * verified live: `post_id` is required, and there is NO `dry_run` (it also
 * accepts `visibility`, which libi does not set).
 *
 * `metadata` is written ONLY when the caller supplies `patch.libi` — a patch
 * carries no `libi` block of its own, so writing one from nothing would
 * REPLACE the post's `metadata.libi`, losing the `pieceId` and the
 * `requestId` a recovery scan matches on. The caller is expected to pass back
 * the post's OWN existing `pieceId` / `requestId` / … here (extending, never
 * inventing, that shape) — `toUpdateBody` only adds `targetOptions`, derived
 * from `patch.targets` so the two can never disagree, the same restore path
 * `toCreateBody` feeds on create.
 */
export function toUpdateBody(patch: UpdatePostInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (patch.content !== undefined) body.content = patch.content;
  // Media is RE-SENT on any update that must keep it, and what is re-sent is
  // the ORIGINAL upload URL.
  //
  // Not because omitting `media_items` is known to fail: that was measured
  // once and did NOT reproduce an hour later, when omitting it answered 200
  // with the media intact — as did re-sending the provider's promoted URL
  // (`.superpowers/sdd/zernio-live-shapes.md`, both measurements). What the
  // second pass explained is WHY the first one failed: the promoted `media/`
  // copy lives and dies with the post that references it, while the
  // uploaded `temp/` original persists. So a round-tripped URL is fragile by
  // construction and its failure blames the user's media. Re-sending the
  // upload's own URL is the behaviour that is safe under both readings,
  // which is why it is the one kept.
  if (patch.media) body.media_items = toMediaItems(patch.media);
  if (patch.targets) {
    const b = toCreateBody({ requestId: patch.requestId, content: "", media: [], targets: patch.targets, when: { mode: "draft" }, libi: { pieceId: "" } }, true);
    body.platforms = b.platforms;
    if (b.tiktok_settings) body.tiktok_settings = b.tiktok_settings;
  }
  if (patch.libi) {
    body.metadata = {
      libi: {
        ...patch.libi,
        ...(patch.targets ? { targetOptions: patch.targets.map((t) => t.options) } : {}),
        ...(patch.media?.[0]?.url ? { mediaUrl: patch.media[0].url } : {}),
      },
    };
  }
  if (patch.when?.mode === "cancel") body.is_draft = true;
  else if (patch.when?.mode === "draft") body.is_draft = true;
  else if (patch.when?.mode === "schedule") {
    body.is_draft = false;
    body.scheduled_for = patch.when.scheduledFor;
    body.timezone = patch.when.timezone;
  } else if (patch.when?.mode === "now") {
    body.is_draft = false;
    body.publish_now = true;
  }
  return body;
}

/**
 * A TikTok dry run's answer: `{ dryRun: true, canPublish, tiktok: [...] }`
 * (the tool's own documented shape, 2026-09-20). It is NOT a post and never
 * normalizes to one — `toPost` on this payload yields a blank post with no id,
 * which is why `dry_run` has its own adapter method.
 */
export function toDryRun(raw: unknown): TikTokDryRun {
  const r = rec(raw);
  const rows = Array.isArray(r.tiktok) ? r.tiktok : [];
  const perAccount = rows.map((x) => {
    const a = rec(x);
    return {
      accountId: str(a.accountId) ?? str(a.account_id),
      canPublish: a.canPublish !== false && a.can_publish !== false,
      reason: str(a.reason) ?? str(a.message) ?? str(a.error),
    };
  });
  return {
    // Trust the provider's own verdict; fall back to the per-account rows
    // rather than inventing a `true` the server never said.
    canPublish: typeof r.canPublish === "boolean" ? r.canPublish : perAccount.length > 0 && perAccount.every((a) => a.canPublish),
    perAccount,
  };
}

/** One `accounts_list_tik_tok_commercial_music` track. `id` is the publishable
 *  song clip id; `commercialMusicId` is rejected by TikTok at publish time. */
export function toTikTokTrack(raw: unknown): CatalogTrack {
  const r = rec(raw);
  return {
    id: idText(r.id) ?? "",
    title: str(r.name) ?? "",
    ...(str(r.artist) ? { artist: str(r.artist) } : {}),
    ...(num(r.durationSec) !== undefined ? { durationSec: num(r.durationSec) } : {}),
    ...(str(r.previewUrl) ? { previewUrl: str(r.previewUrl) } : {}),
    ...(str(r.thumbnailUrl) ? { artworkUrl: str(r.thumbnailUrl) } : {}),
    kind: "trending",
    ...(num(r.rank) !== undefined ? { rank: num(r.rank) } : {}),
  };
}

/** One Instagram audio asset. An original sound carries `igUsername` instead of `displayArtist`. */
export function toInstagramTrack(raw: unknown, kind: "search" | "trending"): CatalogTrack {
  const r = rec(raw);
  const ms = num(r.durationInMs);
  const artist = str(r.displayArtist) ?? str(r.igUsername);
  return {
    id: idText(r.audioId) ?? "",
    title: str(r.title) ?? "",
    ...(artist ? { artist } : {}),
    ...(ms !== undefined ? { durationSec: Math.round(ms / 1000) } : {}),
    ...(str(r.downloadUrl) ? { previewUrl: str(r.downloadUrl) } : {}),
    kind,
  };
}
