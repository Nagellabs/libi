import { accountById, accountRef, newId, type FakeState, type Row } from "./state";
import { LISTED_TOOL_DEFS, recordedInputSchema } from "./schemas";
import { CURATED_TOOLS, FULL_SHAPED_TOOLS, REACHABLE_TOOLS, unknownToolText } from "./live-surface";

/**
 * What every fake tool answers with.
 *
 *  - `value` — a payload, printed as a Python repr into `{ result: … }`.
 *  - `prose` — a `result` string used VERBATIM. This is what Zernio's CURATED
 *    convenience tools really send (`"Found 2 connected account(s): …"`), and
 *    it is neither JSON nor a Python literal, so `parseZernioPayload` throws
 *    "answered in a format libi cannot read" on it. That failure is the point:
 *    it is the tripwire that catches an op resolving to a lossy tool.
 *  - `error` — an `isError` result whose text is the provider's own.
 */
export type ToolAnswer =
  | { kind: "value"; value: unknown }
  | { kind: "prose"; text: string }
  | { kind: "error"; text: string };

const value = (v: unknown): ToolAnswer => ({ kind: "value", value: v });
const prose = (text: string): ToolAnswer => ({ kind: "prose", text });

/**
 * A provider failure in Zernio's own words: `Error: [422] … (code: …)`.
 * `toSocialError`'s `STATUS_IN_TEXT` reads the status out of exactly this
 * shape, which is how a 422 becomes `validation` and a 429 `rate_limited`.
 */
const fail = (status: number, message: string, code?: string): ToolAnswer => ({
  kind: "error",
  text: `Error: [${status}] ${message}${code ? ` (code: ${code})` : ""}`,
});

const nowIso = (): string => new Date().toISOString();

/**
 * The provider's OTHER timestamp spelling: `"2026-09-19 11:00:24"` —
 * space-separated, no zone (verified live). `new Date()` reads it as LOCAL
 * time; `normalize.ts#isoTime` exists solely to stop that, so the fake has to
 * keep sending it.
 */
const nowNaive = (): string => new Date().toISOString().replace("T", " ").slice(0, 19);

const asArray = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const asRow = (v: unknown): Row => (v && typeof v === "object" ? (v as Row) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export interface ToolContext {
  state: FakeState;
  /** `http://127.0.0.1:<port>` — what a presigned URL is built from. */
  baseUrl: string;
}

export type ToolHandler = (args: Row, ctx: ToolContext) => ToolAnswer;

// ---------------------------------------------------------------------------
// Shared behaviour
// ---------------------------------------------------------------------------

/** Live: the first write of a rate-limited window answers 429. */
function rateGate(state: FakeState): ToolAnswer | null {
  if (!state.cfg.rateLimitOnce || state.rateLimited) return null;
  state.rateLimited = true;
  return { kind: "error", text: "Error: [429] Too Many Requests. Retry-After: 2" };
}

/**
 * Publish every pending target row. A row whose platform matches the
 * scenario's `failTarget` fails with that provider message; the post's own
 * status is then `published` / `partial` / `failed` by how many did.
 */
function publish(state: FakeState, post: Row): void {
  const rows = asArray(post.platforms);
  for (const row of rows) {
    if (row.status === "published") continue;
    const failTarget = state.cfg.failTarget;
    if (failTarget && row.platform === failTarget.platform) {
      row.status = "failed";
      row.errorMessage = failTarget.errorMessage;
      row.publishAttempts = Number(row.publishAttempts ?? 0) + 1;
      continue;
    }
    const platformPostId = newId(row.platform === "instagram" ? "17999" : "tt");
    row.status = "published";
    row.platformPostId = platformPostId;
    row.platformPostUrl =
      row.platform === "instagram"
        ? `https://www.instagram.com/reel/${platformPostId}/`
        : `https://www.tiktok.com/@nagellabs/video/${platformPostId}`;
    delete row.errorMessage;
  }
  const failed = rows.filter((r) => r.status === "failed").length;
  post.status = rows.length === 0 ? "published" : failed === 0 ? "published" : failed === rows.length ? "failed" : "partial";
  post.publishedAt = nowIso();
  post.updatedAt = nowIso();
}

/**
 * Turn a write body's `platforms[]` into the rows a post ANSWERS with.
 *
 * Two live asymmetries are reproduced here and must not be tidied away:
 *  - the request sends `accountId` as a STRING; the answer carries it as an
 *    OBJECT (`{_id, platform, username, …}`) on every posts endpoint, while
 *    the analytics endpoint sends the string;
 *  - a DRAFT's rows still carry a `scheduledFor` (≈ now) and
 *    `status: "pending"`, which means nothing and must never render as a
 *    schedule.
 */
function toPlatformRows(state: FakeState, platforms: Row[], scheduledFor: string): Row[] {
  return platforms.map((p) => {
    const account = accountById(state, p.accountId);
    return {
      ...p,
      accountId: account ? accountRef(account) : p.accountId,
      status: "pending",
      scheduledFor,
    };
  });
}

/**
 * Live: a write that names no `account_id` while several accounts share the
 * platform is refused WITH the candidate list, and the agent is expected to
 * read it and retry. Silently picking the first was removed upstream.
 */
function ambiguityError(state: FakeState, platforms: Row[]): ToolAnswer | null {
  for (const p of platforms) {
    if (p.accountId) continue;
    const matches = state.accounts.filter((a) => a.platform === p.platform);
    if (matches.length > 1) {
      return fail(
        400,
        `account_id is required for ${String(p.platform)}: candidates ${matches.map((m) => `${String(m._id)} (@${String(m.username)})`).join(", ")}`,
        "ambiguous_account",
      );
    }
  }
  return null;
}

/** The shared create, behind both `posts_create_post` and curated `posts_create`. */
function createPost(ctx: ToolContext, body: Row): ToolAnswer {
  const { state } = ctx;
  const limited = rateGate(state);
  if (limited) return limited;
  state.createCount += 1;
  if (state.cfg.duplicateOnSecondCreate && state.createCount === 2) {
    return fail(409, "Duplicate content detected: this content was already posted to this account in the last 24 hours", "duplicate_content");
  }
  const platforms = asArray(body.platforms);
  const ambiguous = ambiguityError(state, platforms);
  if (ambiguous) return ambiguous;

  const scheduledFor = str(body.scheduled_for) || new Date(Date.now() + 3600_000).toISOString();
  const status = body.is_draft === true ? "draft" : body.publish_now === true ? "publishing" : "scheduled";
  const post: Row = {
    _id: newId("post"),
    content: str(body.content),
    title: body.title,
    // The REQUEST spells it `media_items`; the ANSWER spells it `mediaItems`.
    mediaItems: asArray(body.media_items),
    platforms: toPlatformRows(state, platforms, scheduledFor),
    scheduledFor,
    timezone: str(body.timezone) || "UTC",
    status,
    tags: Array.isArray(body.tags) ? body.tags : [],
    hashtags: Array.isArray(body.hashtags) ? body.hashtags : [],
    mentions: Array.isArray(body.mentions) ? body.mentions : [],
    visibility: "public",
    crosspostingEnabled: body.crossposting_enabled === true,
    // `metadata` round-trips intact — and cannot be filtered on.
    metadata: { ...asRow(body.metadata), usageCounted: false },
    tiktokSettings: body.tiktok_settings,
    recycling: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  if (body.dry_run === true) {
    // TikTok-only, and never a post (`{ dryRun, canPublish, tiktok[] }`).
    const tiktok = platforms.filter((p) => p.platform === "tiktok");
    if (tiktok.length === 0) return fail(400, "dry_run requires at least one TikTok target", "dry_run_requires_tiktok");
    return value({
      dryRun: true,
      canPublish: true,
      tiktok: tiktok.map((p) => ({ accountId: str(p.accountId), canPublish: true, reason: null })),
    });
  }

  state.posts.set(str(post._id), post);
  if (body.publish_now === true) publish(state, post);
  return value({ post });
}

function requirePost(state: FakeState, postId: unknown): Row | ToolAnswer {
  const post = state.posts.get(str(postId));
  return post ?? fail(404, `Post ${str(postId)} not found`, "not_found");
}

const isAnswer = (v: Row | ToolAnswer): v is ToolAnswer => "kind" in v;

// ---------------------------------------------------------------------------
// Prose — what the CURATED convenience tools really send
// ---------------------------------------------------------------------------

function accountsProse(state: FakeState): string {
  const lines = state.accounts.map((a) => `- ${String(a.platform)}: @${String(a.username)} (id: ${String(a._id)})`);
  return `Found ${state.accounts.length} connected account(s):\n${lines.join("\n")}`;
}

function postProse(post: Row): string {
  const rows = asArray(post.platforms).map((r) => String(r.platform)).join(", ");
  return `Post ${String(post._id)} — ${String(post.status)}\nPlatforms: ${rows}\nContent: ${str(post.content)}`;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

const METRICS: Row = {
  impressions: 14102, reach: 9880, likes: 418, comments: 27, shares: 61, saves: 140,
  clicks: 210, views: 12412, follows: 33, igReelsAvgWatchTime: 4200, igReelsVideoViewTotalTime: 52_000_000,
  reelsSkipRate: 0.12, completionRate: 0.41, profileViews: 88, websiteClicks: 12,
  impressionSources: null, audienceTypes: null, reposts: 4, videoDurationSeconds: 21, engagementRate: 4.6,
  lastUpdated: nowNaive(),
};

/**
 * The SINGLE-POST analytics shape: the metrics array is `platformAnalytics`,
 * the post is keyed `postId`, and each row's `accountId` is a STRING (it is an
 * OBJECT on every posts endpoint). "Still syncing" is signalled by
 * `syncStatus`, never by zeros — a post reported as 0 views is a number the
 * provider never said.
 */
/** A stable pseudo-random scale for an id, so every post in a fixture does not
 *  report the identical numbers — which makes a per-post view impossible to
 *  read and hides a component that renders the wrong post's figures. */
function spread(seed: string): number {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 0.35 + ((h % 1000) / 1000) * 1.9;
}

function scaledMetrics(seed: string): Row {
  const k = spread(seed);
  const n = (v: number) => Math.round(v * k);
  return {
    ...METRICS,
    impressions: n(Number(METRICS.impressions ?? 0)),
    reach: n(Number(METRICS.reach ?? 0)),
    views: n(Number(METRICS.views ?? 0)),
    likes: n(Number(METRICS.likes ?? 0)),
    comments: n(Number(METRICS.comments ?? 0)),
    shares: n(Number(METRICS.shares ?? 0)),
    saves: n(Number(METRICS.saves ?? 0)),
    engagementRate: Math.round(Number(METRICS.engagementRate ?? 0) * k * 10) / 10,
    lastUpdated: nowNaive(),
  };
}

function singlePostAnalytics(state: FakeState, post: Row, syncing: boolean): Row {
  const rows = asArray(post.platforms).map((r) => {
    const account = asRow(r.accountId);
    // An Instagram STORY is never in post analytics at all, live: it stays
    // `pending` forever and its numbers come from the story-insights endpoint
    // (`.superpowers/sdd/zernio-live-shapes.md`). A fake that synced one would
    // let the "syncing forever" bug back in unnoticed.
    const isStory = asRow(r.platformSpecificData).contentType === "story";
    // A target that FAILED has no figures — reporting them would make a failed
    // publish read as a successful one.
    const failed = r.status === "failed" || r.status === "cancelled";
    const pending = syncing || isStory;
    const base: Row = {
      platform: r.platform,
      status: r.status,
      platformPostId: r.platformPostId ?? null,
      accountId: str(account._id) || str(r.accountId),
      accountUsername: str(account.username) || "nagellabs",
      platformPostUrl: r.platformPostUrl ?? null,
      errorMessage: r.errorMessage ?? null,
      syncStatus: pending ? "pending" : failed ? "synced" : "synced",
    };
    if (pending || failed) return base;
    return { ...base, analytics: scaledMetrics(`${str(post._id)}:${str(r.platform)}`) };
  });
  return {
    postId: str(post._id),
    latePostId: str(post._id),
    content: str(post.content),
    publishedAt: post.publishedAt ?? null,
    scheduledFor: post.scheduledFor,
    status: post.status,
    platform: asArray(post.platforms)[0]?.platform ?? "instagram",
    platformPostUrl: asArray(post.platforms)[0]?.platformPostUrl ?? null,
    isExternal: false,
    isAd: false,
    profileId: "6aae6a1e8d284ffb211adc02",
    thumbnailUrl: null,
    mediaType: "VIDEO",
    mediaItems: post.mediaItems ?? [],
    mediaProductType: "REELS",
    isAiGenerated: true,
    isSharedToFeed: true,
    platformAnalytics: rows,
    ...(syncing ? {} : { analytics: scaledMetrics(str(post._id)), lastUpdated: nowNaive() }),
  };
}

/**
 * The PAGE shape, answered when no `post_id` is given: `{ overview, posts,
 * pagination, accounts, hasAnalyticsAccess }`. It carries one `isExternal`
 * post because the live page does — a post the user published outside libi
 * shows up in libi's dashboard, and a fake that never sends one lets that path
 * go unexercised.
 */
function analyticsPage(state: FakeState): Row {
  const posts = [...state.posts.values()].filter((p) => p.status === "published" || p.status === "partial");
  const rows = posts.map((p) => singlePostAnalytics(state, p, false));
  return {
    overview: {
      totalPosts: state.posts.size,
      publishedPosts: posts.length,
      scheduledPosts: [...state.posts.values()].filter((p) => p.status === "scheduled").length,
      lastSync: nowNaive(),
      dataStaleness: { staleAccountCount: 0, syncTriggered: false },
    },
    posts: [
      ...rows,
      { postId: "ext_1", latePostId: null, content: "Posted straight from the phone", status: "published", isExternal: true, isAd: false, platform: "instagram", platformAnalytics: [], analytics: { ...METRICS, lastUpdated: nowNaive() }, lastUpdated: nowNaive() },
    ],
    pagination: { page: 1, limit: 50, total: rows.length + 1, pages: 1 },
    accounts: state.accounts.map((a) => ({ _id: a._id, platform: a.platform, username: a.username })),
    hasAnalyticsAccess: true,
  };
}

// ---------------------------------------------------------------------------
// Ads
// ---------------------------------------------------------------------------

/**
 * Live, on the user's Instagram (no linked Facebook):
 *
 *     Error: [422] A connected Facebook account is required to manage
 *     Instagram ads. (code: linked_account_required)
 *
 * An expected state, not a crash — the Ads tab shows it verbatim. The TikTok
 * wording below was never observed (no TikTok ads account exists to ask); it
 * is the same 422 class, and is marked here so nobody treats it as recorded.
 */
function adsGate(state: FakeState, accountId: unknown): ToolAnswer | null {
  // `ad_campaigns_list_ads` takes NO required account_id — its filters are the
  // scope, and live it answers `{'ads': [], 'pagination': {...}}` with none
  // given (verified 2026-09-21). Gating on an absent id turned that into a
  // 404 and hid every ad.
  if (accountId === undefined || accountId === null || accountId === "") return null;
  const account = accountById(state, accountId);
  if (!account) return fail(404, `Account ${str(accountId)} not found`, "not_found");
  if (state.cfg.adsEnabled && account.platform === "instagram") return null;
  if (account.platform === "instagram") {
    return fail(422, "A connected Facebook account is required to manage Instagram ads.", "linked_account_required");
  }
  return fail(422, "Ads are not available for this account.", "linked_account_required");
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * Every tool the fake serves, by EXACT name. `tools/list` advertises only the
 * curated subset (`LISTED_TOOL_DEFS`); everything else in here is reachable
 * only through `call_tool`, exactly as live — which is what makes a resolver
 * that prefers the listed name distinguishable from one that dispatches the
 * right one.
 */
export const HANDLERS: Record<string, ToolHandler> = {
  // ---- full-shaped (unlisted) ---------------------------------------------
  accounts_list_accounts: (a, { state }) => {
    const platform = str(a.platform);
    const rows = platform ? state.accounts.filter((x) => x.platform === platform) : state.accounts;
    return value({ accounts: rows, hasAnalyticsAccess: true });
  },
  accounts_get_tik_tok_creator_info: (a, { state }) => {
    const account = accountById(state, a.account_id);
    if (!account) return fail(404, `Account ${str(a.account_id)} not found`, "not_found");
    if (account.platform !== "tiktok") return fail(422, "This account is not a TikTok account.", "wrong_platform");
    return value({
      creator: { nickname: account.username, avatarUrl: account.profilePicture, isVerified: false, canPostMore: true },
      // Live: this account offers exactly ONE privacy level
      // (`.superpowers/sdd/zernio-live-shapes.md`) — a richer default here would hide the
      // one bug this fake exists to catch. `multiLevelTikTokPrivacy` is the explicit,
      // opt-in way to exercise a picker.
      privacyLevels: state.cfg.multiLevelTikTokPrivacy
        ? [{ value: "PUBLIC_TO_EVERYONE", label: "Everyone" }, { value: "MUTUAL_FOLLOW_FRIENDS", label: "Friends" }]
        : [{ value: "PUBLIC_TO_EVERYONE", label: "Everyone" }],
      postingLimits: {
        maxVideoDurationSec: 600,
        interactionSettings: {
          allow_comment: { enabled: true, required: true, default: false, label: "Comments" },
          allow_duet: { enabled: true, required: true, default: false, label: "Duet" },
          allow_stitch: { enabled: true, required: true, default: false, label: "Stitch" },
        },
      },
      commercialContentTypes: [{ value: "none", label: "None" }, { value: "brand_organic", label: "Your brand" }],
    });
  },
  posts_create_post: (a, ctx) => createPost(ctx, a),
  posts_get_post: (a, { state }) => {
    const post = requirePost(state, a.post_id);
    return isAnswer(post) ? post : value({ post });
  },
  posts_list_posts: (a, { state }) => {
    // Live: `page` and `limit` go together or the call is a 400.
    if ((a.page === undefined) !== (a.limit === undefined)) {
      return fail(400, "page and limit must be provided together", "invalid_pagination");
    }
    let list = [...state.posts.values()].sort((x, y) => str(y.createdAt).localeCompare(str(x.createdAt)));
    if (a.status !== undefined) {
      const wanted = str(a.status).split(",").map((s) => s.trim()).filter(Boolean);
      if (wanted.length) list = list.filter((p) => wanted.includes(str(p.status)));
    }
    if (a.platform !== undefined) list = list.filter((p) => asArray(p.platforms).some((r) => r.platform === a.platform));
    if (a.account_id !== undefined) {
      list = list.filter((p) => asArray(p.platforms).some((r) => str(asRow(r.accountId)._id) === str(a.account_id) || str(r.accountId) === str(a.account_id)));
    }
    if (a.date_from !== undefined) list = list.filter((p) => str(p.createdAt) >= str(a.date_from));
    if (a.date_to !== undefined) list = list.filter((p) => str(p.createdAt) <= str(a.date_to));
    if (a.search !== undefined) list = list.filter((p) => str(p.content).toLowerCase().includes(str(a.search).toLowerCase()));
    const limit = Number(a.limit ?? 50);
    const page = Number(a.page ?? 1);
    return value({
      posts: list.slice((page - 1) * limit, page * limit),
      pagination: { page, limit, total: list.length, pages: Math.max(1, Math.ceil(list.length / limit)) },
    });
  },
  posts_update_post: (a, { state }) => {
    const found = requirePost(state, a.post_id);
    if (isAnswer(found)) return found;
    const post = found;
    if (post.status === "published" || post.status === "publishing") {
      return fail(400, "Published posts cannot be updated", "post_immutable");
    }
    if (a.content !== undefined) post.content = a.content;
    if (a.title !== undefined) post.title = a.title;
    if (a.media_items !== undefined) post.mediaItems = asArray(a.media_items);
    if (a.platforms !== undefined) {
      const ambiguous = ambiguityError(state, asArray(a.platforms));
      if (ambiguous) return ambiguous;
      post.platforms = toPlatformRows(state, asArray(a.platforms), str(post.scheduledFor));
    }
    if (a.tiktok_settings !== undefined) post.tiktokSettings = a.tiktok_settings;
    // `metadata` is only replaced when the patch carries one — a patch that
    // omits it must not wipe `metadata.libi`.
    if (a.metadata !== undefined) post.metadata = { ...asRow(a.metadata), usageCounted: false };
    if (a.is_draft === true) {
      post.status = "draft";
    } else if (a.publish_now === true) {
      publish(state, post);
    } else if (a.scheduled_for !== undefined) {
      post.status = "scheduled";
      post.scheduledFor = a.scheduled_for;
      if (a.timezone !== undefined) post.timezone = a.timezone;
      for (const row of asArray(post.platforms)) row.scheduledFor = a.scheduled_for;
    }
    post.updatedAt = nowIso();
    return value({ post });
  },
  posts_delete_post: (a, { state }) => {
    const found = requirePost(state, a.post_id);
    if (isAnswer(found)) return found;
    if (found.status === "published") return fail(400, "Published posts cannot be deleted; use Unpublish", "post_immutable");
    state.posts.delete(str(a.post_id));
    return value({ deleted: true, postId: str(a.post_id) });
  },
  media_get_media_presigned_url: (a, { state, baseUrl }) => {
    const key = `${newId("up")}-${str(a.filename) || "upload.bin"}`;
    state.uploads.set(key, Buffer.alloc(0));
    // The `{ data: … }` wrapper follows the brief; the live answer's wrapper
    // was never printed. `filename` / `content_type` / `size` ARE confirmed.
    return value({ data: { uploadUrl: `${baseUrl}/media/${key}`, publicUrl: `${baseUrl}/media/${key}`, key, expiresIn: 3600 } });
  },
  /**
   * The story-insights endpoint, keyed by the story's INSTAGRAM media id — a
   * target's `platformPostId`, never a Zernio post id. Mirrors the live
   * answer's three `source` states so the UI's "still up" / "final numbers" /
   * "never captured" branches are all reachable from a test.
   *
   * `storyInsights` on the fake's config drives them: a media id it names is
   * answered with that entry, anything else with a `live` block of zeros —
   * which is exactly what the real endpoint returned for a fresh story on a
   * small account (Meta reports counts under 5 as 0).
   */
  instagram_get_instagram_story_insights: (a, { state }) => {
    const entry = state.cfg.storyInsights?.[str(a.story_id)];
    if (entry === "unavailable") return value({ data: { source: "unavailable", metrics: {} } });
    if (entry) return value({ data: entry });
    return value({
      data: {
        source: "live",
        metrics: {
          views: 0, reach: 0, replies: 0, shares: 0, navigation: 0, tapsForward: 0,
          tapsBack: 0, exits: 0, swipesForward: 0, profileVisits: 0, follows: 0,
          reposts: 0, totalInteractions: 0,
        },
      },
    });
  },
  ad_accounts_list_ad_accounts: (a, { state }) => {
    const blocked = adsGate(state, a.account_id);
    return blocked ?? value({ adAccounts: [...state.adAccounts.values()] });
  },
  /**
   * Individual ads, filtered the way the live tool documents: by the id of the
   * organic post an ad boosts. That filter is the whole mechanism behind
   * "which ads run this piece", so the fake honours it exactly — a fake that
   * ignored it would let a broken filter pass.
   */
  ad_campaigns_list_ads: (a, { state }) => {
    const blocked = adsGate(state, a.account_id);
    if (blocked) return blocked;
    let list = [...state.ads.values()];
    const eq = (row: Row, keys: string[], want: unknown) => keys.some((k) => row[k] !== undefined && String(row[k]) === String(want));
    if (a.effective_instagram_media_id !== undefined) {
      list = list.filter((ad) => eq(ad, ["effectiveInstagramMediaId", "effective_instagram_media_id"], a.effective_instagram_media_id));
    }
    if (a.effective_object_story_id !== undefined) {
      list = list.filter((ad) => eq(ad, ["effectiveObjectStoryId", "effective_object_story_id"], a.effective_object_story_id));
    }
    if (a.platform_ad_id !== undefined) list = list.filter((ad) => eq(ad, ["platformAdId", "platform_ad_id"], a.platform_ad_id));
    if (a.status !== undefined) list = list.filter((ad) => String(ad.status).toLowerCase() === String(a.status).toLowerCase());
    const limit = typeof a.limit === "number" ? a.limit : 50;
    return value({ ads: list.slice(0, limit), pagination: { page: 1, limit, total: list.length, pages: Math.ceil(list.length / limit) } });
  },
  ad_campaigns_list_ad_campaigns: (a, { state }) => {
    const blocked = adsGate(state, a.account_id);
    return blocked ?? value({ campaigns: [...state.campaigns.values()] });
  },

  // ---- curated (listed) ---------------------------------------------------
  // The seven names in `ZERNIO_LOSSY_TOOLS` were CONFIRMED live to answer
  // prose. `accounts_get`, `posts_publish_now`, `posts_list_failed` and
  // `zernio_overview` are the same family of convenience wrappers and are
  // treated the same here; that much is inference, not a recording.
  accounts_list: (_a, { state }) => prose(accountsProse(state)),
  accounts_get: (a, { state }) => {
    const match = state.accounts.find((x) => x.platform === a.platform);
    return match
      ? prose(`${String(match.platform)}: @${String(match.username)} (id: ${String(match._id)})`)
      : fail(404, `No connected ${str(a.platform)} account`, "not_found");
  },
  accounts_get_account_health: (a, { state }) => {
    const account = accountById(state, a.account_id);
    if (!account) return fail(404, `Account ${str(a.account_id)} not found`, "not_found");
    return value({
      accountId: account._id,
      platform: account.platform,
      username: account.username,
      displayName: account.displayName,
      status: "healthy",
      tokenStatus: { valid: true, expiresAt: account.tokenExpiresAt, expiresIn: 5_184_000, needsRefresh: false },
      permissions: {
        posting: account.permissions,
        analytics: account.platform === "instagram" ? ["instagram_manage_insights"] : ["video.list"],
        optional: [],
        canPost: true,
        canFetchAnalytics: true,
        analyticsSupported: true,
        missingRequired: [],
      },
      issues: [],
      recommendations: [],
      messagingRestriction: null,
    });
  },
  accounts_get_follower_stats: (_a, { state }) =>
    value({ stats: state.accounts.map((a) => ({ accountId: a._id, platform: a.platform, followers: a.followersCount, change: 12 })) }),
  posts_create: (a, ctx) => {
    // The lossy wrapper: ONE platform, a comma-joined media string, and a
    // prose answer that drops `metadata`, `tiktokSettings` and every
    // `platformSpecificData`. It writes to the same state as the full-shaped
    // tool, so a skill-eval can assert the agent did not reach for it while
    // the post it made is still real.
    const created = createPost(ctx, {
      content: a.content,
      title: a.title,
      is_draft: a.is_draft === true,
      publish_now: a.publish_now === true,
      platforms: [{ platform: a.platform, ...(str(a.account_id) ? { accountId: a.account_id } : {}) }],
      media_items: str(a.media_urls).split(",").map((u) => u.trim()).filter(Boolean).map((url) => ({ type: "video", url })),
      ...(Number(a.schedule_minutes ?? 0) > 0 ? { scheduled_for: new Date(Date.now() + Number(a.schedule_minutes) * 60_000).toISOString() } : {}),
    });
    if (created.kind !== "value") return created;
    return prose(postProse(asRow((created.value as Row).post)));
  },
  posts_get: (a, { state }) => {
    const post = requirePost(state, a.post_id);
    return isAnswer(post) ? post : prose(postProse(post));
  },
  posts_list: (a, { state }) => {
    const wanted = str(a.status);
    const list = [...state.posts.values()].filter((p) => !wanted || str(p.status) === wanted).slice(0, Number(a.limit ?? 10));
    return prose(`Found ${list.length} post(s):\n${list.map((p) => `- ${String(p._id)} (${String(p.status)}): ${str(p.content).slice(0, 60)}`).join("\n")}`);
  },
  posts_update: (a, ctx) => {
    const updated = HANDLERS.posts_update_post({ post_id: a.post_id, ...(a.content ? { content: a.content } : {}), ...(a.title ? { title: a.title } : {}), ...(a.scheduled_for ? { scheduled_for: a.scheduled_for } : {}) }, ctx);
    if (updated.kind !== "value") return updated;
    return prose(postProse(asRow((updated.value as Row).post)));
  },
  posts_delete: (a, ctx) => {
    const deleted = HANDLERS.posts_delete_post({ post_id: a.post_id }, ctx);
    return deleted.kind === "value" ? prose(`Post ${str(a.post_id)} deleted.`) : deleted;
  },
  /**
   * THE ONE GUESS IN THIS FILE. `posts_retry`'s answer shape was never read
   * live (the account has no failed post to retry), and its full-shaped twin
   * `posts_retry_post` does NOT exist — `call_tool` answered
   * `Unknown tool: 'posts_retry_post'` for it on 2026-09-20, which is why this
   * fake refuses that name too.
   *
   * It answers a STRUCTURED `{ post }` rather than prose, because
   * `posts.retry` resolves here and prose would make the op permanently
   * unusable in test mode. If the live tool turns out to be prose,
   * `parseZernioPayload` will say so loudly rather than inventing a post —
   * which is the behaviour to keep, not to work around.
   */
  posts_retry: (a, { state }) => {
    const found = requirePost(state, a.post_id);
    if (isAnswer(found)) return found;
    if (found.status !== "failed" && found.status !== "partial") {
      return fail(400, "Only failed posts can be retried", "not_failed");
    }
    for (const row of asArray(found.platforms)) {
      if (row.status === "failed") {
        row.status = "pending";
        delete row.errorMessage;
      }
    }
    // A retry is the operator having fixed whatever broke.
    state.cfg.failTarget = undefined;
    publish(state, found);
    return value({ post: found });
  },
  posts_cross_post: (a, ctx) => {
    const platforms = str(a.platforms).split(",").map((p) => p.trim()).filter(Boolean);
    const ids = str(a.account_ids).split(",").map((p) => p.trim());
    const created = createPost(ctx, {
      content: a.content,
      is_draft: a.is_draft === true,
      publish_now: a.publish_now === true,
      platforms: platforms.map((platform, i) => ({ platform, ...(ids[i] ? { accountId: ids[i] } : {}) })),
      media_items: str(a.media_urls).split(",").map((u) => u.trim()).filter(Boolean).map((url) => ({ type: "video", url })),
    });
    if (created.kind !== "value") return created;
    return prose(postProse(asRow((created.value as Row).post)));
  },
  posts_publish_now: (a, ctx) => HANDLERS.posts_create({ ...a, publish_now: true, is_draft: false }, ctx),
  posts_list_failed: (a, ctx) => HANDLERS.posts_list({ status: "failed", limit: a.limit }, ctx),
  analytics_get_analytics: (a, { state }) => {
    if (a.post_id === undefined || a.post_id === null) return value(analyticsPage(state));
    const found = requirePost(state, a.post_id);
    if (isAnswer(found)) return found;
    const id = str(a.post_id);
    const seen = (state.analyticsCalls.get(id) ?? 0) + 1;
    state.analyticsCalls.set(id, seen);
    const pendingFor = state.cfg.analyticsPendingCalls ?? 1;
    return value(singlePostAnalytics(state, found, seen <= pendingFor));
  },
  validate_post: (a) =>
    value({
      valid: true,
      results: asArray(a.platforms).map((p) => ({ platform: p.platform, valid: true, errors: [], warnings: [] })),
    }),
  validate_media: (a) => value({ valid: true, url: a.url, errors: [] }),
  docs_search: (a) => value({ results: [{ title: `Zernio docs — ${str(a.query)}`, url: "https://docs.zernio.com/", snippet: "Test-mode documentation stub." }] }),
  zernio_overview: () =>
    prose(
      "Zernio (TEST MODE FAKE) — accounts, posts, analytics and ads over an in-memory store. " +
        "The curated tools here answer prose exactly as they do live; the full-shaped REST tools are " +
        "reachable by exact name through call_tool.",
    ),
  /**
   * `search_tools` answers an ARRAY of full tool definitions (verified live) —
   * including the UNLISTED ones, which is the only way a renamed tool is ever
   * found again. Ranking is deliberately crude, because the live ranking is:
   * "list accounts" answered with six `ad_accounts_*` tools and never
   * mentioned `accounts_list_accounts`.
   */
  search_tools: (a) => {
    const terms = str(a.query).toLowerCase().split(/\s+/).filter(Boolean);
    const scored = REACHABLE_TOOLS.map((name) => {
      const segments = name.toLowerCase().split("_");
      return { name, score: terms.filter((t) => segments.includes(t)).length };
    })
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score || x.name.localeCompare(y.name))
      .slice(0, 10);
    return value(
      scored.map(({ name }) => {
        const listed = LISTED_TOOL_DEFS.find((d) => d.name === name);
        return {
          name,
          title: name,
          description: listed?.description ?? `Zernio ${name.replace(/_/g, " ")}`,
          inputSchema: listed?.inputSchema ?? recordedInputSchema(name),
          annotations: null,
        };
      }),
    );
  },
};

/** A drift guard, asserted by the unit tests: the table serves exactly what the recording says exists. */
export const SERVED_TOOLS = [...CURATED_TOOLS, ...FULL_SHAPED_TOOLS].filter((n) => n !== "call_tool");

export { unknownToolText };
