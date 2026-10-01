import type { SocialAdapter, AdsRead } from "@/lib/social/adapter";
import type { ProviderMcp } from "@/lib/social/mcp-client";
import { SocialError } from "@/lib/social/errors";
import type { SocialProviderId, SocialPlatform } from "@/lib/social/catalog";
import type { AccountMusicFacts, CatalogTrack, MusicCatalogResult, MusicUnavailableReason } from "@/lib/social/music-policy";
import type * as T from "@/lib/social/types";
import { serverLogger as logger } from "@/lib/logger";
import { beginPostIntent, markPostIntentUnknown, resolvePostIntent } from "@/lib/social/links";
import { callOp, resolveOpsFromServer, type OpResolution, type ZernioOp } from "./ops";
import * as N from "./normalize";

type R = Record<string, unknown>;
const rec = (v: unknown): R => (v && typeof v === "object" ? (v as R) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Zernio wraps most answers: `{ data }`, `{ post }`, `{ posts }`, `{ accounts }` … — the first key that fits. */
const unwrap = (raw: unknown, ...keys: string[]): unknown => {
  const r = rec(raw);
  for (const k of keys) if (r[k] !== undefined) return r[k];
  return raw;
};

/**
 * `unwrap`, but it also says WHICH key answered: a write the provider treated
 * as a replay comes back 200 with the post under `existingPost` instead of
 * `post`, and the two are otherwise identical.
 */
function pick(raw: unknown, ...keys: string[]): { key: string | null; value: unknown } {
  const r = rec(raw);
  for (const k of keys) if (r[k] !== undefined) return { key: k, value: r[k] };
  return { key: null, value: raw };
}

/**
 * The failures that mean "this account simply has no ads tree", not "the read
 * broke". Verified live on 2026-09-20: an Instagram account with no linked
 * Facebook answers `Error: [422] A connected Facebook account is required to
 * manage Instagram ads. (code: linked_account_required)` — a 422, so
 * `validation` (`not_found` is the same kind of answer from a server that
 * spells it 404).
 *
 * `forbidden` (403) belongs here for the same reason and is arguably the most
 * expected of the three: libi asks for NO ads scope at all (catalog.ts
 * `OAUTH_SCOPES` — Zernio's only ads scope also permits ad CREATION, which
 * libi will not hold), so a token that answers `403 insufficient_permissions`
 * on an ads read is a correctly-scoped token doing exactly what it should.
 * That is this account's ads tree being unavailable, stated in the provider's
 * own words — not a broken read, and emphatically not a reason to touch the
 * user's sign-in.
 *
 * Everything else — `unauthorized`, `rate_limited`, `unsupported`, a transport
 * `provider` blip — is a real failure and is rethrown, because dressing one up
 * as "ads unavailable" would hide a reconnect prompt or a retryable error
 * behind a permanent-looking message.
 */
const ADS_UNAVAILABLE_KINDS: ReadonlySet<string> = new Set(["validation", "not_found", "forbidden"]);

/** The recency key `listPosts` merges multi-status pages on: most-recent
 *  meaningful timestamp first, falling back through publish → schedule →
 *  create so a draft (no `publishedAt`/`scheduledFor`) still sorts sanely
 *  against a published or scheduled post instead of always losing. */
function recencyOf(p: T.SocialPost): number {
  const iso = p.publishedAt ?? p.scheduledFor ?? p.createdAt;
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * How far BEFORE the intent row was claimed a recovery scan looks. The row is
 * written first, so the post can only be newer — the margin is for clock skew
 * between this machine and Zernio's, not for finding older posts.
 */
const RECOVERY_LOOKBACK_MS = 5 * 60_000;

/**
 * Why an account's music catalog is unavailable (spec §12 answers in the plan).
 * Instagram's Instagram-Login refusal is VERIFIED live (400 +
 * `instagram_audio_requires_facebook_login`). TikTok's refusal for a connection
 * not on the Business-app lane is NOT documented: any 4xx Zernio's own tool
 * answer carries (`statusFromText`) that is not a dead grant, a missing account
 * or a rate limit is read as "not business". A transport-level 4xx is "error".
 * A dead grant is rethrown so `withAdapter` can mark it.
 */
export function musicUnavailableReason(platform: SocialPlatform, err: unknown): MusicUnavailableReason {
  if (!(err instanceof SocialError)) return "error";
  if (err.kind === "unauthorized") throw err;
  if (err.kind === "unsupported") return "unsupported";
  if (platform === "instagram") return /instagram_audio_requires_facebook_login/.test(err.message) ? "needs_facebook_login" : "error";
  // Only Zernio's own answer (a status in the tool result's text) speaks to
  // this connection. A transport 4xx — the SDK's "No valid session ID" 400, a
  // scope 403 — is a failure to ask, and must not record the account personal.
  if (err.statusFromText !== true) return "error";
  const s = err.status ?? 0;
  if (err.kind === "forbidden" || err.kind === "validation" || (err.kind === "provider" && s >= 400 && s < 500)) return "not_business";
  return "error";
}

/**
 * The Zernio `SocialAdapter`: a tool-name → normalized-entity map, nothing
 * more. Tool names are the full-shaped REST ones (`posts_create_post`, never
 * the lossy `posts_create`), dispatched by EXACT NAME whether or not Zernio
 * lists them — it lists almost none of them; `call_tool` reaches the rest. A
 * name Zernio does not know is re-resolved once by `search_tools`, and an op
 * nothing implements fails loudly as `unsupported` rather than being
 * substituted with a different tool.
 * Every method throws `SocialError` — the client wrapper maps transport and
 * tool errors, and nothing here catches one only to rethrow something vaguer.
 *
 * Ads are READ-ONLY by construction: `listAdAccounts` / `listCampaigns` and no
 * mutation of any kind. libi never asked for an ads write scope (catalog.ts,
 * `OAUTH_SCOPES`), so an ad change goes through the user's own agent.
 *
 * Stage-A (live) checklist — spellings this file could not verify:
 *  - `analytics.post`'s own argument (`post_id`) — the live tool answers a
 *    LIST, which `analyticsRowFor` handles either way.
 *  - `ads.campaigns` taking `account_id` (ad accounts are per connected
 *    account; campaigns are assumed to be too). A wrong spelling surfaces as
 *    an "ads unavailable" line carrying the provider's own words, not a crash.
 *  - `validate.post`'s ANSWER shape (its arguments are confirmed: `content`,
 *    `media_items`, `platforms`, and nothing else — see `toValidateBody`).
 */
export class ZernioAdapter implements SocialAdapter {
  readonly providerId: SocialProviderId = "zernio";
  private opsPromise: Promise<OpResolution> | null = null;

  constructor(private readonly mcp: ProviderMcp, private readonly opts: { aiLabelDefault: boolean }) {}

  /** Memoized as a PROMISE so concurrent calls resolve the tool list once; a
   *  failure clears it rather than caching the error. */
  private ops(): Promise<OpResolution> {
    if (!this.opsPromise) {
      this.opsPromise = resolveOpsFromServer(this.mcp).catch((err) => {
        this.opsPromise = null;
        throw err;
      });
    }
    return this.opsPromise;
  }

  /**
   * `callOp` dispatches the op's exact full-shaped name — through `call_tool`
   * when Zernio does not list it, which is the normal case — and throws
   * `unsupported` (501, NOT retryable) for an op no tool implements. A name
   * Zernio answers `Unknown tool` for is re-resolved once by `search_tools`
   * and written back into the memoized resolution.
   */
  private async call<X = unknown>(op: ZernioOp, args: R): Promise<X> {
    return callOp<X>(this.mcp, await this.ops(), op, args);
  }

  async selfCheck(): Promise<{ ok: boolean; missing: string[] }> {
    const { missing } = await this.ops();
    return { ok: missing.length === 0, missing };
  }

  async listAccounts(): Promise<T.SocialAccount[]> {
    return arr(unwrap(await this.call("accounts.list", {}), "accounts", "data")).map(N.toAccount);
  }

  async accountHealth(accountId: string): Promise<T.SocialAccount["health"]> {
    return N.toHealth(unwrap(await this.call("accounts.health", { account_id: accountId }), "data"));
  }

  /**
   * `page` and `limit` go together or the call is a 400 (verified live), and
   * the date filters are `date_from` / `date_to`.
   *
   * Do NOT "make the date arguments consistent" across this file:
   * `posts_list_posts` spells them `date_from` / `date_to` while
   * `analytics_get_analytics` spells the same idea `from_date` / `to_date`
   * (both read off the live tool schemas, 2026-09-20). The inconsistency is
   * Zernio's, and a tidy-up here is a 400 there.
   *
   * **`status` is SINGLE-VALUED at Zernio, not a comma list.** Measured live
   * 2026-09-21: `status: "published,partial"` answers ZERO posts, while
   * `status: "published"` answers the real one — so every multi-status caller
   * (the Dashboard's "Needs attention" and "Recent", the Posts tab's own
   * multi-select filter bar) was silently getting nothing back. Dropping the
   * filter and post-filtering a single page client-side was rejected: the
   * matching posts can sit outside whatever one page happened to come back,
   * which is the same shape of silent-empty-result bug as this fix, just
   * moved rather than closed. Instead: one status or none is still exactly
   * ONE request (unchanged — never multiply the common case); more than one
   * status issues one request PER status and merges the answers here.
   */
  async listPosts(f: T.PostListFilter): Promise<{ posts: T.SocialPost[]; page: number; totalPages: number }> {
    const page = f.page ?? 1;
    const limit = f.limit ?? 50;
    const baseArgs: R = { page, limit };
    if (f.platform) baseArgs.platform = f.platform;
    if (f.accountId) baseArgs.account_id = f.accountId;
    if (f.from) baseArgs.date_from = f.from;
    if (f.to) baseArgs.date_to = f.to;

    const listOnce = async (args: R) => {
      const raw = rec(await this.call("posts.list", args));
      const pg = rec(raw.pagination);
      return {
        posts: arr(unwrap(raw, "posts", "data")).map(N.toPost),
        totalPages: Number(pg.totalPages ?? pg.pages ?? 1),
      };
    };

    if ((f.status?.length ?? 0) <= 1) {
      const args = f.status?.length ? { ...baseArgs, status: f.status[0] } : baseArgs;
      const { posts, totalPages } = await listOnce(args);
      return { posts, page, totalPages };
    }

    // Each sub-request asks for the SAME page/limit within its own status, so
    // the merge below is exact for page 1 — the only page every caller but
    // the Posts tab's own filter bar ever asks for — and a best-effort
    // interleave beyond it: a later page merges each status's OWN later page
    // rather than re-ranking the true global order, which can occasionally
    // over- or under-represent one status relative to another but never
    // drops a whole status the way the joined filter did. `totalPages` takes
    // the max across statuses so "there is more" is never hidden.
    const perStatus = await Promise.all(f.status!.map((status) => listOnce({ ...baseArgs, status })));
    const posts = perStatus
      .flatMap((r) => r.posts)
      .sort((a, b) => recencyOf(b) - recencyOf(a))
      .slice(0, limit);
    return { posts, page, totalPages: Math.max(1, ...perStatus.map((r) => r.totalPages)) };
  }

  async getPost(id: string): Promise<T.SocialPost> {
    return N.toPost(unwrap(await this.call("posts.get", { post_id: id }), "post", "data"));
  }

  /**
   * Create a post, at most once per `requestId` — and say whether this call
   * is the one that created it.
   *
   * **The honest guarantee, because the atomic one is gone.** Zernio's MCP
   * tools declare `additionalProperties: false` and expose no header slot, so
   * the `x-request-id` the REST API documents is unreachable from here
   * (verified live 2026-09-20; sending `headers` REJECTS the call outright and
   * creates nothing). There is therefore no server-side "this request already
   * ran" check. What replaces it:
   *
   *  1. an INTENT ROW written locally before the create is sent, keyed
   *     `(providerId, requestId)` — `social_post_links` cannot serve here
   *     because it is keyed by a provider post id that does not exist yet;
   *  2. `metadata.libi.requestId` stamped INTO the post, so a post libi
   *     created but never learned the id of can still be recognized as its own;
   *  3. a RECOVERY SCAN on any repeat — `posts.list` over the intent's account
   *     from 5 minutes before it was claimed — matched on that stamp
   *     client-side, because `posts_list_posts` cannot filter by metadata;
   *  4. the provider's own 24 h duplicate rejection (409), still treated as
   *     success, as a last backstop.
   *
   * What that does NOT cover, stated plainly: the window between "the request
   * left libi" and "libi learned the id". If Zernio created the post and the
   * answer never arrived, nothing local knows it exists. The scan closes that
   * window only EVENTUALLY — a post created seconds ago may not be in a list
   * yet — and the 409 backstop only catches identical content on the same
   * account inside 24 h.
   *
   * Which is why **a `publishNow` create is never retried automatically**. On a
   * repeat whose scan comes back empty, this throws `needs_confirmation`; only
   * `input.republishConfirmedByUser` (a human, having been shown the unknown
   * outcome) gets past it. Drafts and scheduled posts do retry — nothing is
   * public yet, and the provider's duplicate rejection covers the rest.
   */
  async createPost(input: T.CreatePostInput): Promise<{ post: T.SocialPost; deduped: boolean }> {
    const publishesNow = input.when.mode === "now";
    const { intent, existing } = beginPostIntent({
      providerId: this.providerId,
      requestId: input.requestId,
      pieceId: input.libi.pieceId || null,
      mode: input.when.mode,
    });

    // The id is already known: this logical post exists, full stop.
    if (intent.providerPostId) return { post: await this.getPost(intent.providerPostId), deduped: true };

    // A row that predates this call is a retry of an attempt whose outcome
    // libi never learned. Look before leaping.
    if (existing) {
      const recovered = await this.recoverByRequestId(input, intent.createdAt);
      if (recovered) return { post: this.link(input, recovered), deduped: true };
      if (publishesNow && input.republishConfirmedByUser !== true) {
        throw new SocialError(
          "needs_confirmation",
          "A previous attempt to publish this post may have gone out — libi could not confirm either way, and Zernio offers no way to ask. Check the account, then confirm to publish again.",
          { status: 409 },
        );
      }
    }

    let raw: R;
    try {
      raw = rec(await this.call("posts.create", N.toCreateBody(input, this.opts.aiLabelDefault)));
    } catch (e) {
      if (e instanceof SocialError && e.kind === "duplicate") {
        return { post: this.link(input, await this.findDuplicate(input)), deduped: true };
      }
      // The failure says nothing about whether the provider acted: record that
      // it is unknown (so the NEXT attempt is gated), then scan once in case
      // the post is already there.
      markPostIntentUnknown(this.providerId, input.requestId);
      const recovered = await this.recoverByRequestId(input, intent.createdAt).catch(() => null);
      if (recovered) return { post: this.link(input, recovered), deduped: true };
      throw e;
    }

    if (raw.existingPost !== undefined) {
      return { post: this.link(input, N.toPost(raw.existingPost)), deduped: true };
    }
    const post = this.link(input, N.toPost(unwrap(raw, "post", "data")));
    if (post.status === "partial") {
      // The post EXISTS — `link` above recorded its id before this throws, so
      // a retry reads it back instead of creating a second one.
      throw new SocialError("partial", "some targets failed", {
        status: 207,
        perTarget: post.targets
          .filter((t) => t.error)
          .map((t) => ({ platform: t.platform, accountId: t.accountId, error: t.error as string })),
      });
    }
    return { post, deduped: false };
  }

  /** Record the id against the intent, the moment it is known. */
  private link(input: T.CreatePostInput, post: T.SocialPost): T.SocialPost {
    if (post.id) resolvePostIntent(this.providerId, input.requestId, post.id);
    return post;
  }

  /**
   * The post this `requestId` may already have created.
   *
   * Metadata is not a filter Zernio offers, so this lists the account's recent
   * posts from just before the intent was claimed and matches
   * `metadata.libi.requestId` here. Eventually consistent by nature: a post
   * created a moment ago may not be in the list yet, which is exactly why an
   * empty answer gates a publish-now retry rather than clearing it.
   */
  private async recoverByRequestId(input: T.CreatePostInput, since: Date): Promise<T.SocialPost | null> {
    const from = new Date(since.getTime() - RECOVERY_LOOKBACK_MS).toISOString();
    const { posts } = await this.listPosts({ accountId: input.targets[0]?.accountId, from, limit: 50 });
    const hit = posts.find((p) => p.libi?.requestId === input.requestId);
    if (hit) {
      logger.info(
        { tag: "social", op: "zernio.create_recovered", postId: hit.id, mode: input.when.mode },
        "a create whose answer libi never saw had in fact created this post",
      );
    }
    return hit ?? null;
  }

  /**
   * The provider's 409 carries no post, so it has to be found — carefully.
   *
   * `requestId` first: a post carrying this request's own stamp is
   * unambiguously the one this call would have created. Only if none does
   * that fall back to content, and then ONLY on exactly one match — the same
   * caption on the same account can be a post the user wrote by hand, and
   * adopting it would attach libi's piece to someone else's work and report a
   * post as published that libi never made. Zero or several: stay an error.
   */
  private async findDuplicate(input: T.CreatePostInput): Promise<T.SocialPost> {
    const { posts } = await this.listPosts({ accountId: input.targets[0]?.accountId, limit: 20 });
    const byRequestId = posts.filter((p) => p.libi?.requestId === input.requestId);
    if (byRequestId.length === 1) return byRequestId[0];
    const byContent = posts.filter((p) => p.content === input.content);
    if (byContent.length === 1) return byContent[0];
    throw new SocialError(
      "duplicate",
      "Zernio reports this content was already posted to this account in the last 24 h",
      { status: 409 },
    );
  }

  /**
   * `dry_run` is TikTok-ONLY and answers `{ dryRun, canPublish, tiktok[] }` —
   * never a post. It gets its own method because routing it through
   * `createPost` normalizes that answer into a blank post, and because a dry
   * run creates nothing: no intent row, no link, nothing to dedupe.
   *
   * **The body is built at `mode: "draft"`, whatever the composer's `when`
   * says.** This runs from a `useQuery` on the Review step — it fires on
   * reaching the step and again on every caption edit, before any
   * confirmation and without writing an intent row. Feeding the live `when`
   * through made a publish-now composition send
   * `{is_draft: false, publish_now: true, dry_run: true}`, so the only thing
   * standing between an unconfirmed keystroke and a live post was Zernio
   * preferring `dry_run` over `publish_now` — a precedence nobody has
   * measured and nobody should have to. Forcing draft mode makes the
   * pre-flight structurally incapable of publishing: no `publish_now`, no
   * `scheduled_for`, `is_draft: true`. It costs nothing, because the dry run
   * evaluates the CONTENT and the TikTok settings, never the timing.
   */
  async dryRunTikTok(input: T.CreatePostInput): Promise<T.TikTokDryRun> {
    if (!input.targets.some((t) => t.platform === "tiktok")) {
      // The tool rejects a body with no tiktok entry with a 400; say so here
      // rather than spending a round trip to be told.
      throw new SocialError("validation", "a dry run needs at least one TikTok target — Zernio evaluates no other platform", { status: 422 });
    }
    const body = N.toCreateBody({ ...input, when: { mode: "draft" } }, this.opts.aiLabelDefault);
    return N.toDryRun(await this.call("posts.create", { ...body, dry_run: true }));
  }

  async updatePost(id: string, patch: T.UpdatePostInput): Promise<{ post: T.SocialPost; deduped: boolean }> {
    // No `headers` here either — the tool rejects an unknown argument, and
    // an update is addressed by `post_id`, so a replay patches the same post
    // rather than creating a second one.
    return this.write(id, () => this.call("posts.update", { post_id: id, ...N.toUpdateBody(patch) }));
  }

  async deletePost(id: string): Promise<void> {
    await this.call("posts.delete", { post_id: id });
  }

  async retryPost(id: string): Promise<{ post: T.SocialPost; deduped: boolean }> {
    return this.write(id, () => this.call("posts.retry", { post_id: id }));
  }

  /**
   * The shared tail of `updatePost` / `retryPost`. Same `{ post, deduped }`
   * contract as `createPost`, so every write across the seam can report a
   * replay: `existingPost` in the answer, or a duplicate rejection — a retry
   * that raced another retry — in which case the post we asked about IS the
   * answer, and re-reading it beats telling the user their retry failed.
   */
  private async write(id: string, run: () => Promise<unknown>): Promise<{ post: T.SocialPost; deduped: boolean }> {
    let raw: unknown;
    try {
      raw = await run();
    } catch (e) {
      if (e instanceof SocialError && e.kind === "duplicate") return { post: await this.getPost(id), deduped: true };
      throw e;
    }
    const { key, value } = pick(raw, "existingPost", "post", "data");
    return { post: N.toPost(value), deduped: key === "existingPost" };
  }

  async validatePost(input: T.CreatePostInput): Promise<Array<{ platform: T.SocialTarget["platform"]; ok: boolean; errors: string[] }>> {
    const raw = rec(await this.call("validate.post", N.toValidateBody(input, this.opts.aiLabelDefault)));
    const per = arr(unwrap(raw, "results", "platforms", "data"));
    if (per.length === 0) {
      // One verdict for the whole post: repeat it per target rather than
      // inventing per-platform detail the provider did not send.
      return input.targets.map((t) => ({ platform: t.platform, ok: raw.valid !== false, errors: arr(raw.errors).map(String) }));
    }
    return per.map((x) => {
      const r = rec(x);
      return {
        platform: r.platform as T.SocialTarget["platform"],
        ok: r.valid !== false && arr(r.errors).length === 0,
        errors: arr(r.errors).map((e) => (typeof e === "string" ? e : String(rec(e).message ?? JSON.stringify(e)))),
      };
    });
  }

  /** `media_get_media_presigned_url`'s `filename` / `content_type` / `size` are confirmed live — no stage-A item here. */
  async presign(file: { filename: string; contentType: string; sizeBytes: number }): Promise<{ uploadUrl: string; publicUrl: string; expiresAt: string }> {
    const r = rec(unwrap(await this.call("media.presign", { filename: file.filename, content_type: file.contentType, size: file.sizeBytes }), "data"));
    if (typeof r.uploadUrl !== "string" || typeof r.publicUrl !== "string") {
      throw new SocialError("provider", "presign answered without uploadUrl/publicUrl");
    }
    const expiresIn = Number(r.expiresIn ?? 3600);
    return {
      uploadUrl: r.uploadUrl,
      publicUrl: r.publicUrl,
      expiresAt: new Date(Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000).toISOString(),
    };
  }

  /**
   * The live `analytics_get_analytics` answers a PAGE of posts, not one post
   * (zernio-live-shapes.md) — so the row for `postId` is picked out of it. No
   * row yet is "still syncing", NOT zeros: a post published seconds ago is
   * absent from the analytics page, and reporting 0 views for it would be a
   * number the provider never said.
   */
  async postAnalytics(postId: string): Promise<T.PostAnalytics> {
    const row = analyticsRowFor(postId, await this.call("analytics.post", { post_id: postId }));
    if (row === null) return N.toAnalytics(postId, {}, 202);
    return N.toAnalytics(postId, row);
  }

  async storyInsights(accountId: string, storyMediaId: string): Promise<T.StoryInsights> {
    return N.toStoryInsights(await this.call("analytics.instagramStory", { account_id: accountId, story_id: storyMediaId }));
  }

  async tiktokCreatorInfo(accountId: string): Promise<T.TikTokCreatorInfo> {
    return N.toCreatorInfo(accountId, await this.call("accounts.tiktokCreatorInfo", { account_id: accountId }));
  }

  async musicCatalog(accountId: string, q: { platform: SocialPlatform; query?: string; countryCode?: string }): Promise<MusicCatalogResult> {
    try {
      if (q.platform === "tiktok") {
        const raw = await this.call("music.tiktokCommercial", { account_id: accountId, ...(q.countryCode ? { country_code: q.countryCode } : {}) });
        return { tracks: arr(unwrap(raw, "tracks")).map(N.toTikTokTrack).filter((t) => t.id && t.title) };
      }
      const raw = await this.call("music.instagramSearch", { account_id: accountId, audio_type: "music", ...(q.query ? { q: q.query } : {}) });
      const kind = q.query ? "search" : "trending";
      return { tracks: arr(unwrap(raw, "audio")).map((r) => N.toInstagramTrack(r, kind)).filter((t) => t.id && t.title) };
    } catch (err) {
      const reason = musicUnavailableReason(q.platform, err);
      const e = err instanceof SocialError ? err : null;
      logger.info(
        { tag: "social-music", op: "catalog_unavailable", platform: q.platform, accountId, reason, kind: e?.kind, status: e?.status },
        "music catalog unavailable for this account",
      );
      return { unavailable: { reason, ...(e ? { detail: e.message } : {}) } };
    }
  }

  async getCatalogTrack(accountId: string, trackId: string): Promise<CatalogTrack | null> {
    try {
      const raw = await this.call("music.instagramGet", { account_id: accountId, audio_id: trackId });
      const t = N.toInstagramTrack(unwrap(raw, "audio"), "search");
      return t.id ? t : null;
    } catch (err) {
      if (err instanceof SocialError && (err.kind === "not_found" || err.kind === "validation")) return null;
      throw err;
    }
  }

  async musicAccountFacts(accountId: string, platform: SocialPlatform): Promise<AccountMusicFacts> {
    const r = await this.musicCatalog(accountId, { platform });
    const checkedAt = new Date().toISOString();
    const reason = "unavailable" in r ? r.unavailable.reason : null;
    if (platform === "tiktok") {
      if (reason === null) return { tiktokKind: { value: "business", source: "detected", checkedAt } };
      if (reason === "not_business") return { tiktokKind: { value: "personal", source: "detected", checkedAt } };
      return {};
    }
    if (reason === null) return { instagramFacebookLogin: { value: true, source: "detected", checkedAt } };
    if (reason === "needs_facebook_login") return { instagramFacebookLogin: { value: false, source: "detected", checkedAt } };
    return {};
  }

  async listAdAccounts(accounts?: T.SocialAccount[]): Promise<AdsRead<T.SocialAdAccount>> {
    return this.adsRead("ads.accounts", ["adAccounts", "accounts"], N.toAdAccount, accounts);
  }

  async listCampaigns(accounts?: T.SocialAccount[]): Promise<AdsRead<T.SocialAdCampaign>> {
    return this.adsRead("ads.campaigns", ["campaigns"], N.toCampaign, accounts);
  }

  /**
   * Individual ads, scoped by the FILTER rather than per connected account —
   * which is why this does not go through `adsRead`. `ad_campaigns_list_ads`
   * takes no required `account_id` (unlike `ads.accounts`, which refuses
   * without one) and answers cleanly with none connected: verified live
   * 2026-09-21, `{'ads': [], 'pagination': {...}}`.
   *
   * `effectiveInstagramMediaId` is the whole point: it is the id a published
   * Instagram target already carries as `platformPostId`, so "which ads boost
   * this piece's post" is one call per published target and needs nothing
   * stored.
   */
  async listAds(filter: {
    effectiveInstagramMediaId?: string;
    effectiveObjectStoryId?: string;
    platformAdId?: string;
    limit?: number;
  } = {}): Promise<AdsRead<T.SocialAd>> {
    const args: Record<string, unknown> = { limit: filter.limit ?? 50 };
    if (filter.effectiveInstagramMediaId) args.effective_instagram_media_id = filter.effectiveInstagramMediaId;
    if (filter.effectiveObjectStoryId) args.effective_object_story_id = filter.effectiveObjectStoryId;
    if (filter.platformAdId) args.platform_ad_id = filter.platformAdId;
    try {
      return { items: arr(unwrap(await this.call("ads.list", args), "ads", "data")).map(N.toAd), unavailable: [] };
    } catch (error) {
      // An account with no ads tree is an expected state, and its message is
      // the provider's own — shown verbatim, never turned into a crash.
      if (error instanceof SocialError && ADS_UNAVAILABLE_KINDS.has(error.kind)) {
        logger.info({ tag: "social", op: "zernio.ads_unavailable", zernioOp: "ads.list", kind: error.kind, status: error.status }, "no ads tree");
        return { items: [], unavailable: [{ accountId: "", message: error.message }] };
      }
      throw error;
    }
  }

  /**
   * Ads reads are PER CONNECTED ACCOUNT: `ad_accounts_list_ad_accounts`
   * refuses without an `account_id` (verified live), because an ad account
   * hangs off one connected social account rather than the workspace. An
   * account with no ads tree is an expected answer, kept out of `items` and
   * reported in `unavailable` with the provider's own text verbatim, so the
   * Ads tab can say why instead of showing a failure.
   *
   * Two things a caller must not undo. The account list is PASSED IN by an
   * Ads route that already has it — re-listing it here made every ads render
   * two extra `accounts.list` round trips on top of the per-account fan-out.
   * And the fan-out runs CONCURRENTLY: it was serial, so N accounts cost N
   * round trips end to end.
   *
   * `unavailable` is not a fallback for an empty `items`. Both can be
   * non-empty at once — one account with an ads tree, one without — and the
   * route must render `unavailable` WHENEVER it is non-empty, or the user who
   * sees an incomplete list is never told a word about why.
   */
  private async adsRead<X>(
    op: ZernioOp,
    keys: string[],
    map: (raw: unknown) => X & { id: string },
    accounts?: T.SocialAccount[],
  ): Promise<AdsRead<X>> {
    const targets = accounts ?? (await this.listAccounts());
    type PerAccount = { ok: true; rows: unknown[] } | { ok: false; error: unknown };
    const results = await Promise.all(
      targets.map(async (account): Promise<PerAccount> => {
        try {
          return { ok: true, rows: arr(unwrap(await this.call(op, { account_id: account.id }), ...keys, "data")) };
        } catch (error) {
          // Caught per account so one account's failure cannot leave the
          // others' promises unhandled; a real failure is rethrown below.
          return { ok: false, error };
        }
      }),
    );

    const byId = new Map<string, X>();
    const unavailable: Array<{ accountId: string; message: string }> = [];
    for (const [i, result] of results.entries()) {
      const account = targets[i];
      if (result.ok) {
        for (const raw of result.rows) {
          // Two connected accounts can hang off ONE ad account; first wins.
          const item = map(raw);
          if (!byId.has(item.id)) byId.set(item.id, item);
        }
        continue;
      }
      const e = result.error;
      if (e instanceof SocialError && ADS_UNAVAILABLE_KINDS.has(e.kind)) {
        unavailable.push({ accountId: account.id, message: e.message });
        logger.info(
          { tag: "social", op: "zernio.ads_unavailable", zernioOp: op, accountId: account.id, kind: e.kind, status: e.status },
          "account has no ads tree",
        );
        continue;
      }
      throw e;
    }
    return { items: [...byId.values()], unavailable };
  }
}

/**
 * The analytics row for one post, out of whatever `analytics.post` answered:
 * the live LIST shape (`{ overview, posts: [...], pagination }`), or a
 * single-post payload from a server that answers one. `null` means the
 * provider has no row for this post yet — the caller reports "syncing".
 */
function analyticsRowFor(postId: string, raw: unknown): unknown | null {
  const r = rec(raw);
  const posts = arr(r.posts);
  if (posts.length === 0) return r.posts !== undefined ? null : unwrap(raw, "data");
  const hit = posts.find((p) => {
    const row = rec(p);
    return row._id === postId || row.id === postId || row.latePostId === postId;
  });
  return hit ?? null;
}
