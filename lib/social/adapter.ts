import type { SocialProviderId, KnownPlatform } from "./catalog";
import type {
  SocialAccount,
  SocialPost,
  SocialAdAccount,
  SocialAdCampaign,
  SocialAd,
  PostAnalytics,
  StoryInsights,
  PostListFilter,
  TikTokCreatorInfo,
  CreatePostInput,
  UpdatePostInput,
  TikTokDryRun,
} from "./types";

/**
 * One ads READ, across every connected account.
 *
 * `items` is what could be read. `unavailable` is the EXPECTED answer for an
 * account that has no ads tree — an Instagram account with no linked Facebook
 * answers `[422] A connected Facebook account is required to manage Instagram
 * ads.` (verified live, 2026-09-20) — carrying the provider's own words
 * verbatim so the Ads tab can explain itself instead of rendering a failure.
 * Ads reads are per connected account because Zernio's ad-account tool refuses
 * without an `account_id`, so "unavailable" is per account, never global.
 *
 * **`unavailable` is not a fallback for an empty `items`.** Both are non-empty
 * together the moment one account has an ads tree and another does not, so a
 * route renders `unavailable` WHENEVER it is non-empty — never only when
 * `items` is empty, which would leave the user looking at a silently partial
 * list.
 *
 * There is no write counterpart anywhere in this interface, by design: libi
 * requests no ads write scope (`catalog.ts`, `OAUTH_SCOPES`) and every ad
 * change — including pausing — goes through the user's own agent.
 */
export interface AdsRead<T> {
  items: T[];
  unavailable: Array<{ accountId: string; message: string }>;
}

/**
 * The capability the UI and routes program against. One implementation per
 * provider under `lib/social/providers/<id>/adapter.ts`; the implementation is
 * a thin tool-name → normalized-entity map over the provider's OWN MCP —
 * libi keeps no REST client and no vendored API types. Every method throws
 * `SocialError`, never a raw transport error.
 */
export interface SocialAdapter {
  readonly providerId: SocialProviderId;
  selfCheck(): Promise<{ ok: boolean; missing: string[] }>;
  listAccounts(): Promise<SocialAccount[]>;
  accountHealth(accountId: string): Promise<SocialAccount["health"]>;
  listPosts(filter: PostListFilter): Promise<{ posts: SocialPost[]; page: number; totalPages: number }>;
  getPost(id: string): Promise<SocialPost>;
  // createPost/updatePost/retryPost share one return shape — `requestId` is
  // required on every one of them, and a replay of any can come back as a
  // dedupe (the provider's own 409-on-create contract, plus a retried
  // update/retry landing on an in-flight attempt) — so the caller must be
  // able to see `deduped` on all three, not just createPost.
  createPost(input: CreatePostInput): Promise<{ post: SocialPost; deduped: boolean }>;
  /**
   * The provider's TikTok-only dry run. Separate from `createPost` because it
   * answers `{ dryRun, canPublish, tiktok[] }` rather than a post, and creates
   * nothing — there is no id, no link and nothing to dedupe.
   */
  dryRunTikTok(input: CreatePostInput): Promise<TikTokDryRun>;
  updatePost(id: string, patch: UpdatePostInput): Promise<{ post: SocialPost; deduped: boolean }>;
  deletePost(id: string): Promise<void>;
  retryPost(id: string): Promise<{ post: SocialPost; deduped: boolean }>;
  validatePost(input: CreatePostInput): Promise<Array<{ platform: KnownPlatform; ok: boolean; errors: string[] }>>;
  presign(file: { filename: string; contentType: string; sizeBytes: number }): Promise<{ uploadUrl: string; publicUrl: string; expiresAt: string }>;
  postAnalytics(postId: string): Promise<PostAnalytics>;
  /**
   * One Instagram Story's metrics, keyed by the story's INSTAGRAM media id
   * (a target's `platformPostId`) — NOT the provider's post id. Stories never
   * enter `postAnalytics`, so this is the only way to report on one.
   */
  storyInsights(accountId: string, storyMediaId: string): Promise<StoryInsights>;
  tiktokCreatorInfo(accountId: string): Promise<TikTokCreatorInfo>;
  // Read-only, and a result rather than a bare array: an account with no ads
  // tree is a normal outcome that must reach the UI with the provider's text.
  // Pass the accounts you already listed — a caller rendering the Ads tab has
  // them, and omitting them costs an extra `accounts.list` per read.
  listAdAccounts(accounts?: SocialAccount[]): Promise<AdsRead<SocialAdAccount>>;
  listCampaigns(accounts?: SocialAccount[]): Promise<AdsRead<SocialAdCampaign>>;
  /**
   * Ads, narrowed by the provider's own filters. `effectiveInstagramMediaId`
   * is a published Instagram target's `platformPostId`, which is how an ad is
   * matched to the post — and so to the piece — it boosts.
   */
  listAds(filter?: {
    effectiveInstagramMediaId?: string;
    effectiveObjectStoryId?: string;
    platformAdId?: string;
    limit?: number;
  }): Promise<AdsRead<SocialAd>>;
}
