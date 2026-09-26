/**
 * The Zernio adapter over a STRICT double of the provider MCP
 * (`__tests__/helpers/zernio-fake.ts`): every answer arrives in the real
 * `{ result: "<Python repr>" }` envelope and every argument is validated
 * against the recorded `inputSchema`s, which are `additionalProperties:
 * false`. That strictness is the point — a permissive stub is what let a
 * `headers` argument, a camelCase write body and an unreadable envelope all
 * pass as green.
 *
 * Everything here is a contract the rest of the feature leans on: a replay is
 * success on every write path, a publish-now attempt is never repeated on
 * libi's own initiative, a duplicate is never adopted from someone else's
 * post, a draft's meaningless per-target time never becomes a schedule, a
 * target's failure text reaches the UI verbatim, an account with no ads tree
 * is a normal answer, and an op no tool implements fails as `unsupported`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const logSpies = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ serverLogger: logSpies, mcpLogger: logSpies }));

import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { fakeZernioMcp, LIVE_TOOLS, pythonRepr, rawZernioResult, type ZernioAnswer } from "@/__tests__/helpers/zernio-fake";
import { getDb } from "@/lib/db/client";
import { ZernioAdapter } from "@/lib/social/providers/zernio/adapter";
import { beginPostIntent, postIntent } from "@/lib/social/links";
import { SocialError, isRetryable } from "@/lib/social/errors";
import type { CreatePostInput } from "@/lib/social/types";
import draft from "@/lib/social/providers/zernio/fixtures/post-draft.json";
import partial from "@/lib/social/providers/zernio/fixtures/post-partial.json";
import account from "@/lib/social/providers/zernio/fixtures/account.json";
import campaigns from "@/lib/social/providers/zernio/fixtures/campaigns.json";

const PIECE_ID = "piece_1";

beforeEach(() => {
  const db = createTestDb();
  // `createPost` writes an intent row keyed on the piece before it sends
  // anything, so the piece has to exist.
  seedPiece(db, { id: PIECE_ID });
});
afterEach(() => {
  resetTestDb();
  vi.clearAllMocks();
});

function stub(answers: Record<string, ZernioAnswer>, tools: string[] = LIVE_TOOLS) {
  const { mcp, calls } = fakeZernioMcp(answers, tools);
  return { mcp, calls, adapter: new ZernioAdapter(mcp, { aiLabelDefault: true }) };
}

const ACCOUNT_ID = "6aae6b468d284ffb211ade1e";

const CREATE: CreatePostInput = {
  requestId: "r1",
  content: "The desk setup that finally works",
  media: [{ url: "https://cdn.example/export.mp4", type: "video" }],
  targets: [{ platform: "instagram", accountId: ACCOUNT_ID, options: { platform: "instagram", instagram: { contentType: "reel" } } }],
  when: { mode: "draft" },
  libi: { pieceId: PIECE_ID },
};

const PUBLISH_NOW: CreatePostInput = { ...CREATE, requestId: "r-now", when: { mode: "now" } };

/** A post the provider would return for `CREATE`, carrying libi's stamp. */
const stamped = (over: Record<string, unknown> = {}) => ({
  ...draft,
  content: CREATE.content,
  metadata: { libi: { pieceId: PIECE_ID, requestId: "r1" } },
  ...over,
});

describe("ZernioAdapter — the wire format", () => {
  it("reads an answer that arrives in the real { result: '<Python repr>' } envelope", async () => {
    // Proof the envelope is real here and not a convenience: the same payload
    // as a raw JSON string is what the seam must cope with.
    expect(pythonRepr({ post: { content: "it's live", ok: true, missing: null } })).toBe(
      `{'post': {'content': "it's live", 'ok': True, 'missing': None}}`,
    );
    const { adapter } = stub({ posts_get_post: { post: { ...draft, content: "it's live" } } });
    const post = await adapter.getPost("post_draft_1");
    expect(post.id).toBe("post_draft_1");
    expect(post.content).toBe("it's live");
  });

  it("an unreadable answer is a loud failure, never a blank entity", async () => {
    // What a prose-flattening tool really sends: an inner string that is
    // neither JSON nor a Python literal.
    const { adapter } = stub({ accounts_list_accounts: rawZernioResult("Found 2 connected account(s): - instagram: @nagel") });
    // The prose-flattening convenience tools are denied at the resolver; if
    // one ever answers anyway, it must NOT normalize to [].
    await expect(adapter.listAccounts()).rejects.toMatchObject({ kind: "provider" });
  });

  it("sends the write body in snake_case, and an unknown top-level argument is REJECTED", async () => {
    const { adapter, calls } = stub({ posts_create_post: { post: stamped() } });
    await adapter.createPost(CREATE);
    const args = calls[0].args;
    expect(calls[0].name).toBe("posts_create_post");
    expect(args).toMatchObject({ is_draft: true, tags: ["libi"] });
    expect(args.media_items).toEqual([{ type: "video", url: "https://cdn.example/export.mp4" }]);
    expect(args.headers).toBeUndefined();
    // camelCase at the TOP level would fail the call...
    expect(Object.keys(args)).not.toContain("isDraft");
    expect(Object.keys(args)).not.toContain("mediaItems");
    // ...but INSIDE platforms[] the REST API's camelCase is what is expected.
    expect(args.platforms).toEqual([
      { platform: "instagram", accountId: ACCOUNT_ID, platformSpecificData: { contentType: "reel", isAiGenerated: true } },
    ]);
  });

  it("the double rejects an unknown argument the way the live server does", async () => {
    const { mcp } = stub({ posts_create_post: { post: stamped() } });
    // This is the call the adapter used to make. It creates nothing live.
    const err = await mcp
      .call("posts_create_post", { content: "x", headers: { "x-request-id": "r1" } })
      .catch((e: unknown) => e as SocialError);
    expect(err).toBeInstanceOf(SocialError);
    expect((err as SocialError).message).toContain("Unexpected keyword argument");
  });

  it("stamps requestId into metadata.libi and reads it back off the post", async () => {
    const { adapter, calls } = stub({ posts_create_post: { post: stamped() } });
    const r = await adapter.createPost(CREATE);
    // `targetOptions` rides along with `pieceId`/`requestId` — the only way a
    // reopened TikTok draft can restore what it chose, since Zernio never
    // echoes `tiktok_settings` back (verified live, 2026-09-20).
    // `mediaUrl` rides along for the same reason: the URL the post carries
    // after attach is the promoted `media/` copy, which 404s and cannot be
    // re-sent on an update (verified live, 2026-09-20).
    expect(calls[0].args.metadata).toEqual({
      libi: { pieceId: PIECE_ID, requestId: "r1", targetOptions: CREATE.targets.map((t) => t.options), mediaUrl: CREATE.media[0].url },
    });
    expect(r.post.libi?.requestId).toBe("r1");
  });
});

describe("ZernioAdapter — writes", () => {
  it("createPost returns the normalized post and records its id against the intent", async () => {
    const { adapter } = stub({ posts_create_post: { post: stamped() } });
    const r = await adapter.createPost(CREATE);
    expect(r.post.id).toBe("post_draft_1");
    expect(r.deduped).toBe(false);
    expect(postIntent("zernio", "r1")).toMatchObject({ providerPostId: "post_draft_1", state: "linked" });
  });

  it("a second create with a known id never posts again — it reads the post back", async () => {
    const first = stub({ posts_create_post: { post: stamped() } });
    await first.adapter.createPost(CREATE);

    const second = stub({ posts_get_post: { post: stamped() } });
    const r = await second.adapter.createPost(CREATE);
    expect(r.deduped).toBe(true);
    expect(second.calls.map((c) => c.name)).toEqual(["posts_get_post"]);
  });

  it("THE CRASH WINDOW: an intent row with no id makes the retry scan before it creates", async () => {
    // The row a create that never came back leaves behind.
    beginPostIntent({ providerId: "zernio", requestId: "r1", pieceId: PIECE_ID, mode: "draft" });

    const { adapter, calls } = stub({
      posts_list_posts: { posts: [stamped()], pagination: { page: 1, totalPages: 1 } },
    });
    const r = await adapter.createPost(CREATE);
    expect(r.deduped).toBe(true);
    expect(r.post.id).toBe("post_draft_1");
    // The scan ran, and nothing was created.
    expect(calls.map((c) => c.name)).toEqual(["posts_list_posts"]);
    expect(calls[0].args).toMatchObject({ account_id: ACCOUNT_ID, limit: 50 });
    expect(typeof calls[0].args.date_from).toBe("string");
    expect(postIntent("zernio", "r1")?.providerPostId).toBe("post_draft_1");
  });

  it("the scan finding nothing lets a DRAFT retry create — nothing is public yet", async () => {
    beginPostIntent({ providerId: "zernio", requestId: "r1", pieceId: PIECE_ID, mode: "draft" });
    const { adapter, calls } = stub({
      posts_list_posts: { posts: [], pagination: { page: 1, totalPages: 1 } },
      posts_create_post: { post: stamped() },
    });
    await expect(adapter.createPost(CREATE)).resolves.toMatchObject({ deduped: false });
    expect(calls.map((c) => c.name)).toEqual(["posts_list_posts", "posts_create_post"]);
  });

  it("A PUBLISH-NOW CREATE IS NEVER AUTO-RETRIED — it stops for a human", async () => {
    beginPostIntent({ providerId: "zernio", requestId: "r-now", pieceId: PIECE_ID, mode: "now" });
    const { adapter, calls } = stub({
      posts_list_posts: { posts: [], pagination: { page: 1, totalPages: 1 } },
      posts_create_post: { post: stamped({ _id: "post_second", status: "published" }) },
    });
    const err = await adapter.createPost(PUBLISH_NOW).catch((e: unknown) => e as SocialError);
    expect((err as SocialError).kind).toBe("needs_confirmation");
    // Scanned, then STOPPED. Nothing was published a second time.
    expect(calls.map((c) => c.name)).toEqual(["posts_list_posts"]);
    expect(isRetryable(err as SocialError, { kind: "write", publishesNow: true })).toBe(false);
    // …and it stays refused however many times the caller asks again.
    await expect(adapter.createPost(PUBLISH_NOW)).rejects.toMatchObject({ kind: "needs_confirmation" });
  });

  it("only the user's explicit confirmation gets a publish-now second attempt through", async () => {
    beginPostIntent({ providerId: "zernio", requestId: "r-now", pieceId: PIECE_ID, mode: "now" });
    const { adapter, calls } = stub({
      posts_list_posts: { posts: [], pagination: { page: 1, totalPages: 1 } },
      posts_create_post: { post: stamped({ _id: "post_second", status: "published" }) },
    });
    const r = await adapter.createPost({ ...PUBLISH_NOW, republishConfirmedByUser: true });
    expect(r.post.id).toBe("post_second");
    expect(calls.map((c) => c.name)).toEqual(["posts_list_posts", "posts_create_post"]);
  });

  it("a failed create marks the outcome unknown and scans once before giving up", async () => {
    const { adapter, calls } = stub({
      posts_create_post: () => { throw new SocialError("provider", "upstream broke", { status: 502 }); },
      posts_list_posts: { posts: [], pagination: { page: 1, totalPages: 1 } },
    });
    await expect(adapter.createPost(PUBLISH_NOW)).rejects.toMatchObject({ kind: "provider" });
    expect(calls.map((c) => c.name)).toEqual(["posts_create_post", "posts_list_posts"]);
    expect(postIntent("zernio", "r-now")).toMatchObject({ state: "unknown", providerPostId: null });
  });

  it("a failed create whose post DID land is recovered by its requestId, not reported as a failure", async () => {
    const { adapter } = stub({
      posts_create_post: () => { throw new SocialError("provider", "the answer never arrived", { status: 502 }); },
      posts_list_posts: { posts: [stamped({ metadata: { libi: { pieceId: PIECE_ID, requestId: "r-now" } } })], pagination: { page: 1, totalPages: 1 } },
    });
    const r = await adapter.createPost(PUBLISH_NOW);
    expect(r).toMatchObject({ deduped: true });
    expect(r.post.id).toBe("post_draft_1");
  });

  it("a replay answered with existingPost is SUCCESS, deduped", async () => {
    const { adapter } = stub({ posts_create_post: { existingPost: stamped() } });
    const r = await adapter.createPost(CREATE);
    expect(r.deduped).toBe(true);
    expect(r.post.id).toBe("post_draft_1");
  });

  it("a 409 duplicate on create is SUCCESS too — the existing post is matched by requestId", async () => {
    const { adapter, calls } = stub({
      posts_create_post: () => { throw new SocialError("duplicate", "already posted", { status: 409 }); },
      posts_list_posts: { posts: [stamped()], pagination: { page: 1, totalPages: 1 } },
    });
    const r = await adapter.createPost(CREATE);
    expect(r.deduped).toBe(true);
    expect(r.post.id).toBe("post_draft_1");
    expect(calls[1].args).toMatchObject({ account_id: ACCOUNT_ID, limit: 20 });
  });

  it("NEVER adopts a same-content post that is not libi's own work", async () => {
    // Two posts with this caption on this account: the user's own, and a
    // second one. Content alone cannot tell them apart, so nothing is adopted.
    const handWritten = { ...draft, _id: "post_by_hand", content: CREATE.content, metadata: {} };
    const alsoHandWritten = { ...draft, _id: "post_by_hand_2", content: CREATE.content, metadata: {} };
    const { adapter } = stub({
      posts_create_post: () => { throw new SocialError("duplicate", "already posted", { status: 409 }); },
      posts_list_posts: { posts: [handWritten, alsoHandWritten], pagination: { page: 1, totalPages: 1 } },
    });
    await expect(adapter.createPost(CREATE)).rejects.toMatchObject({ kind: "duplicate" });

    // And with libi's own stamp present, that post wins over the hand-written
    // one rather than the list order deciding.
    const { adapter: adapter2 } = stub({
      posts_create_post: () => { throw new SocialError("duplicate", "already posted", { status: 409 }); },
      posts_list_posts: { posts: [handWritten, stamped()], pagination: { page: 1, totalPages: 1 } },
    });
    await expect(adapter2.createPost(CREATE)).resolves.toMatchObject({ post: expect.objectContaining({ id: "post_draft_1" }), deduped: true });
  });

  it("a 409 whose post cannot be found stays an error rather than inventing one", async () => {
    const { adapter } = stub({
      posts_create_post: () => { throw new SocialError("duplicate", "already posted", { status: 409 }); },
      posts_list_posts: { posts: [], pagination: { page: 1, totalPages: 1 } },
    });
    await expect(adapter.createPost(CREATE)).rejects.toMatchObject({ kind: "duplicate" });
  });

  it("a partial create throws with each failed target's text verbatim — but records the post first", async () => {
    const { adapter } = stub({ posts_create_post: { post: partial } });
    const err = await adapter.createPost(CREATE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialError);
    expect((err as SocialError).kind).toBe("partial");
    expect((err as SocialError).perTarget).toEqual([
      { platform: "tiktok", accountId: "6aae6ba98d284ffb211ae03a", error: "Selected privacy level 'SELF_ONLY' is not available for this creator" },
    ]);
    // The post EXISTS; a retry must read it back, not create a second one.
    expect(postIntent("zernio", "r1")?.providerPostId).toBe("post_partial_1");
  });

  it("updatePost and retryPost report a replay the same way createPost does, with no headers argument", async () => {
    const u = stub({ posts_update_post: { existingPost: draft } });
    await expect(u.adapter.updatePost("post_draft_1", { requestId: "r1", content: "x" })).resolves.toMatchObject({ deduped: true });
    expect(u.calls[0].args).toEqual({ post_id: "post_draft_1", content: "x" });

    const r = stub({ posts_retry: { existingPost: partial } });
    await expect(r.adapter.retryPost("post_partial_1")).resolves.toMatchObject({ deduped: true });

    const plain = stub({ posts_retry: { post: partial } });
    await expect(plain.adapter.retryPost("post_partial_1")).resolves.toMatchObject({ deduped: false });
  });

  it("an update re-sends the ORIGINAL temp URL — the promoted one, and no media at all, both fail the whole call", async () => {
    // Zernio's own words, measured live on 2026-09-20 against the user's
    // account: attaching promotes `media.zernio.com/temp/…` to
    // `media.zernio.com/media/…`, the promoted URL 404s, and re-sending it —
    // or omitting `media_items` entirely — fails the update with this text.
    const MEDIA_400 = "Error: [400] Some media files failed to upload. Please re-upload your media and try again.";
    const TEMP = "https://media.zernio.com/temp/1_e.mp4";
    const PROMOTED = "https://media.zernio.com/media/1_e.mp4";
    const server = (args: Record<string, unknown>) => {
      const items = args.media_items as Array<{ url: string }> | undefined;
      if (!items?.length || items.some((m) => m.url.includes("/media/"))) throw new Error(MEDIA_400);
      return { post: draft };
    };

    const omitted = stub({ posts_update_post: server });
    await expect(omitted.adapter.updatePost("post_draft_1", { requestId: "r1", content: "x" })).rejects.toMatchObject({
      message: expect.stringContaining("Some media files failed to upload"),
    });

    const echoed = stub({ posts_update_post: server });
    await expect(
      echoed.adapter.updatePost("post_draft_1", { requestId: "r1", media: [{ url: PROMOTED, type: "video" }] }),
    ).rejects.toMatchObject({ message: expect.stringContaining("Some media files failed to upload") });

    const original = stub({ posts_update_post: server });
    await expect(
      original.adapter.updatePost("post_draft_1", { requestId: "r1", media: [{ url: TEMP, type: "video" }], libi: { pieceId: PIECE_ID } }),
    ).resolves.toMatchObject({ post: expect.objectContaining({ id: "post_draft_1" }) });
    expect(original.calls[0].args.media_items).toEqual([{ type: "video", url: TEMP }]);
    // …and the URL that worked is stamped back, so the NEXT update has it.
    expect((original.calls[0].args.metadata as { libi: { mediaUrl?: string } }).libi.mediaUrl).toBe(TEMP);
  });

  it("a duplicate rejection on update/retry is success: the post is read back, deduped", async () => {
    const dup = () => { throw new SocialError("duplicate", "a retry is already running", { status: 409 }); };
    const u = stub({ posts_update_post: dup, posts_get_post: { post: draft } });
    await expect(u.adapter.updatePost("post_draft_1", { requestId: "r1" })).resolves.toEqual({ post: expect.objectContaining({ id: "post_draft_1" }), deduped: true });

    const r = stub({ posts_retry: dup, posts_get_post: { post: partial } });
    await expect(r.adapter.retryPost("post_partial_1")).resolves.toMatchObject({ deduped: true });
  });

  it("a 401 stays unauthorized — the adapter never dresses it as a provider blip", async () => {
    const { adapter } = stub({
      posts_create_post: () => { throw new SocialError("unauthorized", "no", { status: 401 }); },
      posts_list_posts: { posts: [], pagination: {} },
    });
    const err = await adapter.createPost(CREATE).catch((e: unknown) => e as SocialError);
    expect((err as SocialError).kind).toBe("unauthorized");
    expect((err as SocialError).status).toBe(401);
    expect(isRetryable(err as SocialError, { kind: "read" })).toBe(false);
  });

  it("a dry run is its own call — TikTok-only, and never normalized as a post", async () => {
    const tiktokInput: CreatePostInput = {
      ...CREATE,
      requestId: "r-dry",
      targets: [{
        platform: "tiktok",
        accountId: "6aae6ba98d284ffb211ae03a",
        options: { platform: "tiktok", tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true, allowDuet: true, allowStitch: true, commercialContentType: "none", contentPreviewConfirmed: true, expressConsentGiven: true } },
      }],
    };
    const { adapter, calls } = stub({
      posts_create_post: { dryRun: true, canPublish: false, tiktok: [{ accountId: "6aae6ba98d284ffb211ae03a", canPublish: false, reason: "daily limit reached" }] },
    });
    const r = await adapter.dryRunTikTok(tiktokInput);
    expect(calls[0].args.dry_run).toBe(true);
    expect(r).toEqual({ canPublish: false, perAccount: [{ accountId: "6aae6ba98d284ffb211ae03a", canPublish: false, reason: "daily limit reached" }] });
    // No post was created, so no intent row was claimed for it.
    expect(postIntent("zernio", "r-dry")).toBeNull();

    // An Instagram-only body is a 400 live; it never leaves libi.
    const ig = stub({});
    await expect(ig.adapter.dryRunTikTok(CREATE)).rejects.toMatchObject({ kind: "validation" });
    expect(ig.calls).toEqual([]);
  });

  /**
   * THE pre-flight invariant: a dry run cannot publish, whatever the
   * composition says.
   *
   * It runs from a `useQuery` on the Review step — on arrival at the step and
   * again on every caption edit, before any confirmation and without an
   * intent row. Feeding the composer's live `when` through made a
   * publish-now composition send
   * `{is_draft: false, publish_now: true, dry_run: true}`, leaving nothing
   * between an unconfirmed keystroke and a live post but Zernio's own
   * (unmeasured) precedence of `dry_run` over `publish_now`. The body is
   * built at `mode: "draft"` instead, so there is nothing to have a
   * precedence about.
   */
  it("a dry run NEVER carries publish_now or is_draft: false — for any `when` the composer can hold", async () => {
    const tiktokTarget = {
      platform: "tiktok" as const,
      accountId: "6aae6ba98d284ffb211ae03a",
      options: { platform: "tiktok" as const, tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true, allowDuet: true, allowStitch: true, commercialContentType: "none" as const, contentPreviewConfirmed: true, expressConsentGiven: true } },
    };
    const whens: Array<CreatePostInput["when"]> = [
      { mode: "draft" },
      { mode: "schedule", scheduledFor: "2030-01-01T09:00", timezone: "Asia/Bangkok" },
      { mode: "now" },
    ];
    for (const when of whens) {
      const { adapter, calls } = stub({
        posts_create_post: { dryRun: true, canPublish: true, tiktok: [{ accountId: tiktokTarget.accountId, canPublish: true }] },
      });
      await adapter.dryRunTikTok({ ...CREATE, requestId: `r-dry-${when.mode}`, targets: [tiktokTarget], when });
      const args = calls[0].args;
      expect(args.dry_run).toBe(true);
      expect(args.publish_now).toBeUndefined();
      expect(args.is_draft).toBe(true);
      // A schedule would also have leaked the slot into a body that is only
      // ever meant to be evaluated, never stored.
      expect(args.scheduled_for).toBeUndefined();
      // And a dry run still claims no intent row, whatever the mode.
      expect(postIntent("zernio", `r-dry-${when.mode}`)).toBeNull();
    }
  });
});

describe("ZernioAdapter — intent rows and the piece they belong to", () => {
  it("an intent row goes away with its piece (FK cascade)", async () => {
    const { adapter } = stub({ posts_create_post: { post: stamped() } });
    await adapter.createPost(CREATE);
    expect(postIntent("zernio", "r1")).not.toBeNull();

    const db = getDb();
    db.run("DELETE FROM pieces WHERE id = 'piece_1'" as never);
    expect(postIntent("zernio", "r1")).toBeNull();
  });
});

describe("ZernioAdapter — reads", () => {
  it("listPosts sends page+limit together and only the filters Zernio has, for a single status", async () => {
    const { adapter, calls } = stub({ posts_list_posts: { posts: [draft], pagination: { page: 1, totalPages: 1 } } });
    const r = await adapter.listPosts({ status: ["draft"], platform: "tiktok", limit: 50 });
    // The common case — zero or one status — is still exactly ONE request,
    // never multiplied.
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ status: "draft", platform: "tiktok", limit: 50, page: 1 });
    expect(r.posts[0].status).toBe("draft");
    expect(r.totalPages).toBe(1);
  });

  it("no status filter at all sends no status argument, still one request", async () => {
    const { adapter, calls } = stub({ posts_list_posts: { posts: [draft], pagination: { page: 1, totalPages: 1 } } });
    const r = await adapter.listPosts({ limit: 50 });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ limit: 50, page: 1 });
    expect(r.posts).toHaveLength(1);
  });

  /**
   * THE BUG: Zernio's `status` filter is single-valued. Measured live
   * 2026-09-21, `status: "published,partial"` answered ZERO posts while
   * `status: "published"` answered the real one — so the Dashboard's "Needs
   * attention" (`["failed","partial"]`) and "Recent" (`["published",
   * "partial"]`) silently saw nothing, ever. The fix issues one request PER
   * status and merges the answers, most-recent first, capped at `limit`.
   */
  it("a multi-status filter issues one request PER status and merges — never a single joined value", async () => {
    const { adapter, calls } = stub({
      posts_list_posts: ({ status }: { status?: string }) =>
        status === "draft"
          ? { posts: [draft], pagination: { page: 1, totalPages: 1 } }
          : status === "partial"
            ? { posts: [partial], pagination: { page: 1, totalPages: 1 } }
            : { posts: [], pagination: { page: 1, totalPages: 1 } },
    });
    const r = await adapter.listPosts({ status: ["draft", "partial"], limit: 50 });
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.args.status).sort()).toEqual(["draft", "partial"]);
    // Never the comma-joined value the live server silently drops.
    expect(calls.every((c) => typeof c.args.status === "string" && !c.args.status.includes(","))).toBe(true);
    // Both statuses' posts come back — the draft (2026-09-20) is more recent
    // than the partial (2026-09-18), so it sorts first.
    expect(r.posts.map((p) => p.id)).toEqual(["post_draft_1", "post_partial_1"]);
  });

  it("a multi-status merge caps at `limit` and reports the max totalPages across statuses", async () => {
    const { adapter } = stub({
      posts_list_posts: ({ status }: { status?: string }) =>
        status === "draft"
          ? { posts: [draft], pagination: { page: 1, totalPages: 3 } }
          : { posts: [partial], pagination: { page: 1, totalPages: 1 } },
    });
    const r = await adapter.listPosts({ status: ["draft", "partial"], limit: 1 });
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0].id).toBe("post_draft_1");
    // "there is more" is never hidden just because one of the merged statuses
    // was already exhausted.
    expect(r.totalPages).toBe(3);
  });

  it("a DRAFT never reports a schedule, however much per-target time the provider echoes", async () => {
    const { adapter } = stub({ posts_get_post: { post: draft } });
    const post = await adapter.getPost("post_draft_1");
    // The fixture's platform rows DO carry scheduledFor — that time is meaningless.
    expect(draft.platforms.every((p) => typeof p.scheduledFor === "string")).toBe(true);
    expect(post.status).toBe("draft");
    expect(post.scheduledFor).toBeUndefined();
  });

  it("a target's failure text survives verbatim", async () => {
    const { adapter } = stub({ posts_get_post: { post: partial } });
    const post = await adapter.getPost("post_partial_1");
    expect(post.targets.find((t) => t.platform === "tiktok")?.error).toBe(
      "Selected privacy level 'SELF_ONLY' is not available for this creator",
    );
    expect(post.targets.find((t) => t.platform === "instagram")?.url).toBe("https://www.instagram.com/reel/abc/");
  });

  it("postAnalytics picks this post's row out of the live LIST answer and reads the nested metrics", async () => {
    const { adapter, calls } = stub({
      analytics_get_analytics: {
        overview: { totalPosts: 2 },
        posts: [
          { _id: "other", platforms: [] },
          {
            _id: "post_partial_1",
            lastUpdated: "2026-09-19 11:00:24",
            platforms: [
              { platform: "instagram", syncStatus: "synced", analytics: { impressions: 4200, likes: 210, engagementRate: 6.8 } },
            ],
          },
        ],
        pagination: { page: 1, pages: 1 },
      },
    });
    const a = await adapter.postAnalytics("post_partial_1");
    expect(calls[0].args).toEqual({ post_id: "post_partial_1" });
    expect(a.syncStatus).toBe("ready");
    expect(a.perTarget).toEqual([{ platform: "instagram", impressions: 4200, reach: undefined, views: undefined, likes: 210, comments: undefined, shares: undefined, saves: undefined, engagementRate: 6.8 }]);
    // Space-separated, no zone — read as UTC rather than handed to new Date().
    expect(a.lastUpdated).toBe("2026-09-19T11:00:24Z");
  });

  it("a post the analytics page has no row for is SYNCING, never zeros", async () => {
    const { adapter } = stub({ analytics_get_analytics: { overview: {}, posts: [{ _id: "other" }], pagination: {} } });
    const a = await adapter.postAnalytics("post_draft_1");
    expect(a.syncStatus).toBe("pending");
    expect(a.perTarget).toEqual([]);
  });

  it("presign turns the provider's expiresIn into an absolute moment", async () => {
    const { adapter, calls } = stub({
      media_get_media_presigned_url: { data: { uploadUrl: "https://up.example/x", publicUrl: "https://cdn.example/x.mp4", expiresIn: 600 } },
    });
    const r = await adapter.presign({ filename: "x.mp4", contentType: "video/mp4", sizeBytes: 10 });
    expect(calls[0].args).toEqual({ filename: "x.mp4", content_type: "video/mp4", size: 10 });
    expect(Date.parse(r.expiresAt)).toBeGreaterThan(Date.now());
    expect(r.uploadUrl).toBe("https://up.example/x");
  });

  it("selfCheck reports every op resolved against the live tool list", async () => {
    const { adapter } = stub({});
    await expect(adapter.selfCheck()).resolves.toEqual({ ok: true, missing: [] });
  });
});

describe("ZernioAdapter — ads are read-only", () => {
  const accounts = { accounts: [account.account, account.accountStringProfileId] };

  it("reads per connected account, and an account with no ads tree is a normal result carrying the provider's words", async () => {
    const message = "Error: [422] A connected Facebook account is required to manage Instagram ads. (code: linked_account_required)";
    const { adapter, calls } = stub({
      accounts_list_accounts: accounts,
      ad_accounts_list_ad_accounts: (args: Record<string, unknown>) => {
        if (args.account_id === ACCOUNT_ID) throw new SocialError("validation", message, { status: 422 });
        return { accounts: [{ _id: "act_1", network: "meta", name: "Nagel Labs Ads", currency: "USD" }] };
      },
    });
    const r = await adapter.listAdAccounts();
    expect(r.items).toEqual([{ id: "act_1", network: "meta", name: "Nagel Labs Ads", currency: "USD", connected: true }]);
    expect(r.unavailable).toEqual([{ accountId: ACCOUNT_ID, message }]);
    // Per connected account: the ad tool refuses without an account_id. And
    // BOTH halves are non-empty here — the route must render `unavailable`
    // whenever it is, not only when `items` is empty.
    expect(r.items.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.name === "ad_accounts_list_ad_accounts").map((c) => c.args)).toEqual([
      { account_id: ACCOUNT_ID },
      { account_id: "6aae6ba98d284ffb211ae03a" },
    ]);
  });

  it("takes the account list from the caller instead of re-listing it", async () => {
    const { adapter, calls } = stub({
      accounts_list_accounts: accounts,
      ad_accounts_list_ad_accounts: { accounts: [] },
      ad_campaigns_list_ad_campaigns: { campaigns: [] },
    });
    const known = await adapter.listAccounts();
    await adapter.listAdAccounts(known);
    await adapter.listCampaigns(known);
    expect(calls.filter((c) => c.name === "accounts_list_accounts")).toHaveLength(1);
  });

  /**
   * The scoped 403 the live account actually hit. libi asks for NO ads scope
   * (catalog.ts `OAUTH_SCOPES`), so this is the EXPECTED answer from a
   * perfectly healthy grant — and it has to read as this account's ads tree
   * being unavailable, in Zernio's own words, exactly like the
   * linked_account_required case above.
   */
  it("a scoped 403 degrades into 'ads unavailable' with the provider's own message", async () => {
    const message = "Error: [403] Your token does not include the ads resource group. (code: insufficient_permissions)";
    const { adapter } = stub({
      accounts_list_accounts: accounts,
      ad_accounts_list_ad_accounts: () => { throw new SocialError("forbidden", message, { status: 403 }); },
    });
    const r = await adapter.listAdAccounts();
    expect(r.items).toEqual([]);
    // EVERY connected account, since the gap is in the grant, not the account.
    expect(r.unavailable).toEqual([
      { accountId: ACCOUNT_ID, message },
      { accountId: "6aae6ba98d284ffb211ae03a", message },
    ]);
  });

  it("a scoped 403 on campaigns degrades the same way", async () => {
    const message = "Error: [403] insufficient_permissions";
    const { adapter } = stub({
      accounts_list_accounts: accounts,
      ad_campaigns_list_ad_campaigns: () => { throw new SocialError("forbidden", message, { status: 403 }); },
    });
    const r = await adapter.listCampaigns();
    expect(r.items).toEqual([]);
    expect(r.unavailable.map((u) => u.message)).toEqual([message, message]);
  });

  it("a real failure is still a failure — a 401 is never dressed up as 'ads unavailable'", async () => {
    const { adapter } = stub({
      accounts_list_accounts: accounts,
      ad_accounts_list_ad_accounts: () => { throw new SocialError("unauthorized", "revoked", { status: 401 }); },
    });
    await expect(adapter.listAdAccounts()).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("campaigns come back lower-cased and de-duplicated across accounts, and nothing is ever written", async () => {
    const { adapter, calls } = stub({
      accounts_list_accounts: accounts,
      ad_campaigns_list_ad_campaigns: { campaigns },
    });
    const r = await adapter.listCampaigns();
    // Both accounts answer the same two campaigns; one ad account, one tree.
    expect(r.items.map((c) => c.id)).toEqual(["camp_1", "camp_2"]);
    expect(r.items.map((c) => c.status)).toEqual(["active", "paused"]);
    expect(r.unavailable).toEqual([]);
    expect(calls.every((c) => !/create|update|delete|pause|resume|publish/.test(c.name))).toBe(true);
  });
});

describe("ZernioAdapter — an op no tool implements", () => {
  it("fails as unsupported, which is NOT retryable", async () => {
    // No retry tool, and no call_tool to dispatch a rename through.
    const tools = LIVE_TOOLS.filter((t) => t !== "posts_retry" && t !== "call_tool" && t !== "search_tools");
    const { adapter, calls } = stub({}, tools);
    const err = await adapter.retryPost("post_partial_1").catch((e: unknown) => e as SocialError);
    expect(err).toBeInstanceOf(SocialError);
    expect((err as SocialError).kind).toBe("unsupported");
    expect((err as SocialError).message).toContain("posts.retry");
    expect(isRetryable(err as SocialError, { kind: "read" })).toBe(false);
    // Nothing was dispatched to a phantom name.
    expect(calls).toEqual([]);
  });
});
