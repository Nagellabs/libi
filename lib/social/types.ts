import type { KnownPlatform, SocialPlatform, InstagramPostType } from "./catalog";
import type { TargetMusic } from "./music-policy";

export type PostStatus = "draft" | "scheduled" | "publishing" | "published" | "partial" | "failed" | "cancelled";
export type TargetStatus = "pending" | "published" | "failed" | "cancelled";

export interface SocialAccount {
  id: string;
  /** Whatever the provider connected — wider than the two libi's own composer
   *  builds for, because the agent connects and posts to the rest. */
  platform: KnownPlatform;
  username: string;
  displayName: string;
  profileUrl?: string;
  active: boolean;
  profileId?: string;
  profileName?: string;
  health?: { status: "healthy" | "reconnect" | "unknown"; tokenExpiresAt?: string };
  /** How many posts Zernio has for this account that were made OUTSIDE libi
   *  (verified live on `accounts_list_accounts`, 2026-09-20) — never a count
   *  libi's own list produced. `undefined` when the row did not carry it. */
  externalPostCount?: number;
}

export interface InstagramOptions {
  contentType: InstagramPostType;
  shareToFeed?: boolean;
  commentsEnabled?: boolean;
  isAiGenerated?: boolean;
  collaborators?: string[];
  firstComment?: string;
}

export interface TikTokOptions {
  privacyLevel: string;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  commercialContentType: "none" | "brand_organic" | "brand_content";
  madeWithAi?: boolean;
  coverTimestampMs?: number;
  /**
   * TikTok's two mandatory consents, as the USER left the checkboxes — not a
   * constant. They are `boolean` rather than `true` precisely so an
   * unconsented draft can be represented and refused: every write route still
   * declares them `z.literal(true)`, so a target that reaches the wire without
   * both is rejected at the boundary instead of being silently sent as
   * consented (which is what a hardcoded `true` in the composer's defaults
   * did).
   */
  contentPreviewConfirmed: boolean;
  expressConsentGiven: boolean;
}

/** `music` is what libi decided for this target's audio (spec §6.4). It rides
 *  in `metadata.libi.targetOptions`, the round-trip stamp, because Zernio never
 *  echoes `tiktok_settings` back. */
export type TargetOptions =
  | { platform: "instagram"; instagram: InstagramOptions; music?: TargetMusic }
  | { platform: "tiktok"; tiktok: TikTokOptions; music?: TargetMusic };

export interface SocialTarget {
  /** A post the AGENT made can target any platform the provider supports, and
   *  libi still lists it — so this is the wide type and `options` is absent
   *  for a platform the composer has no options for. */
  platform: KnownPlatform;
  accountId: string;
  status: TargetStatus;
  platformPostId?: string;
  url?: string;
  error?: string;
  options?: TargetOptions;
}

export interface SocialPost {
  id: string;
  status: PostStatus;
  content: string;
  title?: string;
  /**
   * Set for the whole post only when `status === "scheduled"`. A draft's
   * `targets[].options` (or provider echo) may carry a leftover/meaningless
   * scheduled time on the per-platform rows — never render THAT as a
   * schedule while `status === "draft"`. `SocialTarget` deliberately has no
   * `scheduledFor` field of its own for this reason.
   */
  scheduledFor?: string;
  timezone?: string;
  publishedAt?: string;
  createdAt: string;
  media: Array<{ url: string; type: "video" | "image" }>;
  targets: SocialTarget[];
  tags: string[];
  /**
   * libi's own stamp, round-tripped through the provider's free-form
   * `metadata.libi`. `requestId` is the idempotency key the create was sent
   * with: it is what a recovery scan matches on when libi never learned the
   * post's id (`metadata` is NOT filterable server-side, so the scan lists
   * recent posts and matches here client-side). `targetOptions` is the
   * per-target `options` libi itself chose the last time this post was
   * written — Zernio echoes Instagram's `platformSpecificData` back fine but
   * NEVER `tiktok_settings` (verified live, 2026-09-20), so this is the only
   * way a reopened TikTok draft can recover its own settings instead of
   * falling back to defaults and asking the user to re-consent every time.
   *
   * `mediaUrl` is the URL the UPLOAD itself produced, kept because the one the
   * provider echoes back is unusable: attaching a file promotes it from
   * `media.zernio.com/temp/…` to `media.zernio.com/media/…`, and the promoted
   * URL 404s (verified live 2026-09-20 — `temp/` 200, `media/` 404 for the
   * same object). Re-sending the echoed URL on an update fails the WHOLE call
   * with "Some media files failed to upload", and omitting `media_items`
   * fails identically, so this is what every update must re-send.
   */
  libi?: { pieceId: string; pieceName?: string; exportFile?: string; appVersion?: string; requestId?: string; targetOptions?: TargetOptions[]; mediaUrl?: string };
}

/**
 * One Instagram Story's metrics, from Instagram's OWN story-insights endpoint.
 *
 * Separate from `PostAnalytics` because a Story is not in the provider's
 * post-analytics sync at all (measured 2026-09-21: `syncStatus: "pending"`
 * eight hours and a completed sync cycle after publishing, and absent from the
 * account's analytics list). The metrics are different ones too — a Story has
 * taps and exits, not saves and a completion rate.
 *
 * `source` is the provider's own three-way answer and must reach the user
 * verbatim in meaning:
 * - `live` — the story is still up and these numbers came from Meta just now.
 * - `cached` — the story has expired; these are its final numbers, captured
 *   from Meta's webhook.
 * - `unavailable` — the story has expired and its final numbers were never
 *   captured. Nothing will ever fill this in, so the UI must stop waiting.
 */
export interface StoryInsights {
  source: "live" | "cached" | "unavailable";
  metrics: {
    views?: number;
    reach?: number;
    replies?: number;
    shares?: number;
    /** `tapsForward + tapsBack + exits + swipesForward`, as the provider sums it. */
    navigation?: number;
    tapsForward?: number;
    tapsBack?: number;
    exits?: number;
    swipesForward?: number;
    profileVisits?: number;
    follows?: number;
    reposts?: number;
    totalInteractions?: number;
  };
}

export interface PostAnalytics {
  postId: string;
  syncStatus: "ready" | "pending" | "failed";
  lastUpdated?: string;
  perTarget: Array<{
    platform: KnownPlatform;
    impressions?: number;
    reach?: number;
    views?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    saves?: number;
    engagementRate?: number;
    extras?: Record<string, number>;
  }>;
}

export interface TikTokCreatorInfo {
  accountId: string;
  privacyLevels: string[];
  maxVideoSeconds: number;
  canPostMore: boolean;
  /**
   * Per interaction, as TikTok reports it for THIS account:
   * - `enabled` — the account is allowed to turn it on at all. False means the
   *   switch must be off and un-toggleable; sending true would be rejected.
   * - `required` — the field has to be PRESENT in the create body. It says
   *   nothing about the value, which is why it must never be shown to the user
   *   as "required by TikTok" next to a switch.
   * - `default` — TikTok's own suggested starting value.
   */
  interactions: Record<"allow_comment" | "allow_duet" | "allow_stitch", { enabled: boolean; required: boolean; default: boolean }>;
}

export interface SocialAdCampaign {
  id: string;
  adAccountId: string;
  network: string;
  name: string;
  /** Open union like the rest of this file's status fields — normalized to lowercase in the (future) Zernio normalizer; the raw provider value (e.g. "ACTIVE") rides through unrecognized cases via `(string & {})`. */
  status: "active" | "paused" | (string & {});
  reviewStatus?: string;
  objective?: string;
  budget?: { amount: number; type: "daily" | "lifetime"; currency?: string };
  startDate?: string;
  endDate?: string;
  metrics?: { spend?: number; impressions?: number; clicks?: number; ctr?: number; cpc?: number; cpm?: number };
  linkedPostId?: string;
}

/**
 * One ad, as the provider's ad list reports it.
 *
 * **The field shapes here are still UNVERIFIED against a live ads account** —
 * nobody has connected one yet (`.superpowers/sdd/zernio-live-shapes.md`).
 * Every field is therefore optional and the normalizer accepts both casings;
 * the UI renders only what actually arrived and never a placeholder number.
 * The two ids below are the exception: they are documented on
 * `ad_campaigns_list_ads` as FILTERS, described there as the way to "map a
 * Business-Manager-visible IG post back to the Zernio ad", which is exactly
 * what links an ad to a piece.
 */
export interface SocialAd {
  /** The provider's own ad id. */
  id: string;
  /** The ad-network's id (Meta's ad id), which is what the filters take. */
  platformAdId?: string;
  /** `metaads`, `tiktokads`, … — a SEPARATE key space from posting platforms. */
  network: string;
  name: string;
  status: "active" | "paused" | (string & {});
  campaignId?: string;
  campaignName?: string;
  adSetId?: string;
  adAccountId?: string;
  /** Instagram media id of the boosted post — the same value a published
   *  Instagram target carries as `platformPostId`. */
  effectiveInstagramMediaId?: string;
  /** Facebook `{pageId}_{postId}` of the boosted post. */
  effectiveObjectStoryId?: string;
  previewUrl?: string;
  thumbnailUrl?: string;
  currency?: string;
  metrics?: { spend?: number; impressions?: number; reach?: number; clicks?: number; ctr?: number; cpc?: number; cpm?: number };
  createdAt?: string;
}

/**
 * An ad on a piece's Posting tab, with HOW libi knows it belongs there — the
 * two are genuinely different relationships and the UI shows them differently:
 *
 * - `boosted` — the ad's creative IS one of this piece's published posts. The
 *   provider knows this (`effectiveInstagramMediaId` matches that target's
 *   `platformPostId`), so nothing is stored and it is discovered on every read.
 * - `linked` — the piece went out AS an ad and never existed as an organic
 *   post ("dark post"). Nothing on the provider can tie that back to a piece,
 *   so libi records the link itself, exactly as it already does for posts.
 */
export interface PieceAd {
  ad: SocialAd;
  origin: "boosted" | "linked";
  /** The provider post id this ad boosts — only on `boosted`. */
  boostsPostId?: string;
}

/**
 * One ad on the Social page's Ads tab, placed where libi can place it: the
 * post it boosts (matched by the same ids the Posting tab uses) or the piece
 * libi linked it to. Everything but `ad` is optional — an ad made entirely
 * outside libi has no piece, and that is an ordinary row, not an error.
 */
export interface AdListEntry {
  ad: SocialAd;
  origin: "boosted" | "linked" | "external";
  /** The provider post this ad boosts — only on `boosted`. */
  postId?: string;
  pieceId?: string;
  pieceName?: string;
  /** Something to show for the ad: its own thumbnail, else the boosted post's media. */
  media?: { url: string; type: "video" | "image" };
}

export interface SocialAdAccount {
  id: string;
  network: string;
  name: string;
  currency?: string;
  connected: boolean;
}

export interface CreatePostInput {
  /**
   * One id per LOGICAL post, minted when the compose flow starts and REUSED
   * on every retry (`requestIdForLink`). It is stamped into
   * `metadata.libi.requestId` and recorded in a local intent row before the
   * create is sent — those two together are the whole dedupe contract, since
   * Zernio's MCP tools expose no `x-request-id` header slot
   * (`.superpowers/sdd/zernio-live-shapes.md`).
   */
  requestId: string;
  content: string;
  media: Array<{ url: string; type: "video" | "image"; filename?: string; sizeBytes?: number; mimeType?: string }>;
  targets: Array<{ platform: SocialPlatform; accountId: string; options: TargetOptions }>;
  when: { mode: "draft" } | { mode: "schedule"; scheduledFor: string; timezone: string } | { mode: "now" };
  libi: { pieceId: string; pieceName?: string; exportFile?: string; appVersion?: string };
  /**
   * The ONE way to re-send a `when.mode === "now"` create whose previous
   * attempt with this same `requestId` ended with libi not knowing whether
   * the provider published it.
   *
   * Set it only after a HUMAN has been shown that unknown outcome and asked
   * for a second attempt anyway. Without it the adapter refuses the retry
   * (`SocialError("needs_confirmation")`) rather than risk a double post —
   * there is no server-side atomic dedupe to fall back on.
   */
  republishConfirmedByUser?: true;
}

/**
 * `posts_create_post`'s `dry_run` is TikTok-ONLY and answers
 * `{ dryRun: true, canPublish, tiktok: [...] }` — never a post (verified live
 * on the tool's own schema, 2026-09-20). It gets its own adapter method for
 * that reason: normalizing that answer as a post produces a blank one.
 */
export interface TikTokDryRun {
  canPublish: boolean;
  perAccount: Array<{ accountId?: string; canPublish: boolean; reason?: string }>;
}

export interface UpdatePostInput {
  requestId: string;
  content?: string;
  /**
   * The media to re-send on an update that must keep its media. Send the
   * ORIGINAL upload URL (`metadata.libi.mediaUrl`, or a fresh upload), never
   * the one read back off the post.
   *
   * That rule is the safe one under BOTH live measurements, not a settled
   * fact about the provider: omitting `media_items` failed once with "Some
   * media files failed to upload", and on a later re-measurement both
   * omitting it and re-sending the provider's promoted URL answered 200 with
   * the media intact. The reconciliation is that the promoted `media/` copy
   * dies with the post that references it while the uploaded `temp/`
   * original persists (`.superpowers/sdd/zernio-live-shapes.md`), so a
   * round-tripped URL is fragile by construction — and its failure blames
   * the user's media.
   */
  media?: CreatePostInput["media"];
  targets?: CreatePostInput["targets"];
  when?: CreatePostInput["when"] | { mode: "cancel" }; // "cancel" = scheduled → draft
  /**
   * The post's EXISTING `metadata.libi` fields the caller wants preserved
   * (`pieceId`, `requestId`, …) — `posts_update_post` writes `metadata`
   * wholesale, so omitting one here erases it from the post, not just from
   * this call. `targetOptions` is never accepted from the caller: when
   * `targets` is also given, `toUpdateBody` derives it from those, so the two
   * can never drift against each other.
   */
  libi?: { pieceId: string; pieceName?: string; exportFile?: string; appVersion?: string; requestId?: string; mediaUrl?: string };
}

export interface PostListFilter {
  status?: PostStatus[];
  /** Any platform the provider carries, so the list can be narrowed to one
   *  the agent posts to but libi's composer does not build for. */
  platform?: KnownPlatform;
  accountId?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}
