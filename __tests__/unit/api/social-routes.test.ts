/**
 * `/api/social/*` route tests, over `__setSocialServiceForTests` with a stub
 * adapter — no real Zernio traffic. Two things every test in this file
 * ultimately guards, beyond its own assertion:
 *
 *  - **no response body ever carries a token.** `status()` is the only
 *    shape the service exposes and it structurally cannot carry one
 *    (`lib/social/service.ts`), but this file still greps a representative
 *    sample of bodies for the marker strings as a second line of defense.
 *  - **every route answers through `socialErrorToResponse`**, never an
 *    invented status — proven by throwing a spread of `SocialError` kinds
 *    (plus a bare `Error`) through the SAME adapter call and reading the
 *    status/body back off `errors.ts`'s own mapping.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const tracked = vi.hoisted(() => ({ calls: [] as Array<[string, Record<string, unknown> | undefined]> }));
vi.mock("@/lib/analytics/server", () => ({
  trackServerEvent: (name: string, params?: Record<string, unknown>) => { tracked.calls.push([name, params]); },
}));

const logSpies = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ serverLogger: logSpies, mcpLogger: logSpies }));

import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { __setSocialServiceForTests } from "@/lib/social/service";
import { getSocialSettings, setSocialSettings } from "@/lib/db/settings";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { insertAdLink, insertLink, linkForPost, beginPostIntent, markPostIntentUnknown, resolvePostIntent, touchLinkStatus } from "@/lib/social/links";
import { navigationEmitter } from "@/lib/navigation-events";
import { SocialError, type SocialErrorKind } from "@/lib/social/errors";
import draft from "@/lib/social/providers/zernio/fixtures/post-draft.json";
import { toPost } from "@/lib/social/providers/zernio/normalize";
import type { SocialAdapter } from "@/lib/social/adapter";
import type { SocialAccount } from "@/lib/social/types";

import { GET as status } from "@/app/api/social/status/route";
import { GET as getSettingsRoute, PUT as putSettings } from "@/app/api/social/settings/route";
import { GET as getAccounts } from "@/app/api/social/accounts/route";
import { GET as listPosts, POST as createPost } from "@/app/api/social/posts/route";
import { GET as getOnePost, PATCH as patchPost, DELETE as deleteOnePost } from "@/app/api/social/posts/[postId]/route";
import { POST as retryPost } from "@/app/api/social/posts/[postId]/retry/route";
import { GET as postAnalytics } from "@/app/api/social/posts/[postId]/analytics/route";
import { GET as piecePosts } from "@/app/api/social/pieces/[pieceId]/posts/route";
import { GET as creatorInfo } from "@/app/api/social/tiktok/creator-info/route";
import { GET as adsRoute } from "@/app/api/social/ads/route";
import { POST as linksRoute } from "@/app/api/social/links/route";
import { POST as validateRoute } from "@/app/api/social/validate/route";
import { GET as requestIdRoute } from "@/app/api/social/request-id/route";

const post = toPost(draft);

/** libi's own page: a same-origin browser fetch. The user-only writes — a post
 *  as the user, PATCH, DELETE, retry — take `browserOnlyRefusal` and need it;
 *  a header-less caller's refusal is covered in
 *  __tests__/unit/security/user-only-routes.test.ts. */
const PAGE = { host: "127.0.0.1:3461", origin: "http://127.0.0.1:3461", "sec-fetch-site": "same-origin" };

const account1: SocialAccount = { id: "acc1", platform: "instagram", username: "acc1", displayName: "Acc One", active: true };
const account2: SocialAccount = { id: "acc2", platform: "instagram", username: "acc2", displayName: "Acc Two", active: true };

const navEvents: Array<{ event: string; payload: unknown }> = [];
navigationEmitter.on("refresh_query", (payload) => navEvents.push({ event: "refresh_query", payload }));

/** Install a stub `SocialService` for one test. `overrides` fills in the
 *  adapter methods that test exercises; anything not overridden is simply
 *  absent, so a route calling an un-stubbed method fails loudly rather than
 *  silently answering `undefined`. */
function stubService(overrides: Partial<Record<string, unknown>> = {}, opts: { connected?: boolean; needsReconnect?: boolean } = {}) {
  const adapter: Record<string, unknown> = {
    providerId: "zernio",
    listPosts: async () => ({ posts: [post], page: 1, totalPages: 1 }),
    createPost: async () => ({ post, deduped: false }),
    ...overrides,
  };
  __setSocialServiceForTests({
    async status() {
      return {
        providerId: "zernio" as const,
        connected: opts.connected ?? true,
        needsReconnect: opts.needsReconnect ?? false,
        scopes: ["posts:read"],
        connectedAt: "x",
      };
    },
    async adapter() {
      if (opts.connected === false) {
        throw new SocialError(
          "unauthorized",
          opts.needsReconnect ? "libi's connection was revoked" : "libi is not connected",
          { status: 401 },
        );
      }
      return adapter as unknown as SocialAdapter;
    },
    markUnauthorized() {},
    reset() {},
    disconnect() {},
  });
}

beforeEach(() => {
  createTestDb();
  setSocialSettings({ providerId: "zernio", timezone: null, defaults: { instagramType: "reel", aiLabel: true }, pollSeconds: 30 });
  tracked.calls.length = 0;
  navEvents.length = 0;
  for (const spy of Object.values(logSpies)) spy.mockClear();
});

function loggedText(): string {
  return [logSpies.info, logSpies.warn, logSpies.error, logSpies.debug]
    .flatMap((spy) => spy.mock.calls)
    .map((call) => JSON.stringify(call))
    .join("\n");
}

afterEach(() => {
  resetTestDb();
});

function noToken(body: unknown): void {
  expect(JSON.stringify(body)).not.toMatch(/access_token|refresh_token/);
}

describe("/api/social/status", () => {
  it("never carries a token and includes the catalog + settings", async () => {
    stubService();
    const body = await (await status()).json();
    noToken(body);
    expect(body.catalog[0].id).toBe("zernio");
    expect(body.settings.defaults.aiLabel).toBe(true);
  });

  it("distinguishes a plain not-connected state from a revoked grant", async () => {
    stubService({}, { connected: false, needsReconnect: false });
    const notConnected = await (await status()).json();
    expect(notConnected).toMatchObject({ connected: false, needsReconnect: false });

    stubService({}, { connected: false, needsReconnect: true });
    const revoked = await (await status()).json();
    expect(revoked).toMatchObject({ connected: false, needsReconnect: true });
  });
});

describe("/api/social/settings", () => {
  it("GET returns the stored settings", async () => {
    const body = await (await getSettingsRoute()).json();
    expect(body.providerId).toBe("zernio");
    expect(body.defaults.aiLabel).toBe(true);
  });

  it("PUT persists and does NOT reset the service when the provider is unchanged", async () => {
    stubService();
    const res = await putSettings(new Request("http://x/api/social/settings", {
      method: "PUT",
      headers: PAGE,
      body: JSON.stringify({ providerId: "zernio", timezone: "Asia/Bangkok", defaults: { instagramType: "feed", aiLabel: false }, pollSeconds: 30 }),
    }));
    expect(res.status).toBe(200);
    expect(getSocialSettings().timezone).toBe("Asia/Bangkok");
    expect(tracked.calls).toEqual([]);
    expect(navEvents).toHaveLength(1);
  });

  it("PUT resets the service and tracks social_provider_selected when the provider changes", async () => {
    stubService();
    const res = await putSettings(new Request("http://x/api/social/settings", {
      method: "PUT",
      headers: PAGE,
      body: JSON.stringify({ providerId: null, timezone: null, defaults: { instagramType: "reel", aiLabel: true }, pollSeconds: 30 }),
    }));
    expect(res.status).toBe(200);
    expect(tracked.calls).toEqual([["social_provider_selected", { provider: "none" }]]);
  });

  it("400s on an invalid body rather than persisting garbage", async () => {
    const before = getSocialSettings();
    const res = await putSettings(new Request("http://x/api/social/settings", { method: "PUT", headers: PAGE, body: JSON.stringify({ providerId: "not-a-real-provider" }) }));
    expect(res.status).toBe(400);
    expect(getSocialSettings()).toEqual(before);
  });

  // The provider and the defaults every new post is seeded from (aiLabel) are
  // the user's: an agent's shell must not rewrite them with a header-less curl.
  it("PUT refuses a header-less loopback caller and changes nothing", async () => {
    stubService();
    const before = getSocialSettings();
    const res = await putSettings(new Request("http://x/api/social/settings", {
      method: "PUT",
      headers: { host: "127.0.0.1:3461" },
      body: JSON.stringify({ providerId: "zernio", timezone: "UTC", defaults: { instagramType: "reel", aiLabel: false }, pollSeconds: 30 }),
    }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("browser_only");
    expect(getSocialSettings()).toEqual(before);
    expect(navEvents).toHaveLength(0);
  });
});

describe("/api/social/accounts", () => {
  it("decorates each account with health; a failed health read leaves it as the list already had it, never failing the list", async () => {
    stubService({
      listAccounts: async () => [account1, account2],
      accountHealth: async (id: string) => {
        if (id === "acc2") throw new Error("boom");
        return { status: "healthy" as const };
      },
    });
    const body = await (await getAccounts()).json();
    noToken(body);
    expect(body.accounts).toHaveLength(2);
    const one = body.accounts.find((a: { id: string }) => a.id === "acc1");
    const two = body.accounts.find((a: { id: string }) => a.id === "acc2");
    expect(one.health).toEqual({ status: "healthy" });
    expect(two.health).toBeUndefined();
  });
});

describe("/api/social/posts", () => {
  it("list parses filters and decorates with link rows", async () => {
    stubService();
    const res = await listPosts(new Request("http://x/api/social/posts?status=draft,scheduled&platform=tiktok"));
    const body = await res.json();
    noToken(body);
    expect(body.posts[0].id).toBe("post_draft_1");
    expect(body.posts[0].link).toBeNull();
  });

  it("create writes the link row for the piece and answers the post, reusing the caller's requestId rather than minting a fresh one", async () => {
    const requestId = randomUUID();
    const seenRequestIds: string[] = [];
    stubService({
      createPost: async (input: { requestId: string }) => {
        seenRequestIds.push(input.requestId);
        return { post, deduped: false };
      },
    });
    const [p] = getDb().insert(pieces).values({ name: "x" }).returning().all();
    const res = await createPost(new Request("http://x/api/social/posts", {
      method: "POST",
      headers: PAGE,
      // `createdBy` is explicit here for the same reason the composer sends
      // it: the route's default is `"agent"`, so an omission is the RESTRICTED
      // answer, never "the user did it".
      body: JSON.stringify({ requestId, content: "hi", media: [], targets: [], when: { mode: "draft" }, libi: { pieceId: p.id }, exportPath: "/e.mp4", createdBy: "ui" }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    noToken(body);
    // The dedupe guard IS this id being reused across retries — the adapter
    // must see the exact id the caller sent, never a fresh one per attempt.
    expect(seenRequestIds).toEqual([requestId]);
    expect(linkForPost("zernio", "post_draft_1")).toMatchObject({ providerPostId: "post_draft_1", pieceId: p.id, requestId, createdBy: "ui", exportPath: "/e.mp4" });
    expect(tracked.calls).toEqual([["social_post_created", { provider: "zernio", platform_count: "0", mode: "draft", source: "ui" }]]);
    expect(navEvents.some((e) => (e.payload as { pieceId?: string }).pieceId === p.id)).toBe(true);
  });

  it("400s on an invalid create body (bad requestId) rather than reaching the adapter", async () => {
    stubService({ createPost: async () => { throw new Error("should not be called"); } });
    const res = await createPost(new Request("http://x/api/social/posts", {
      method: "POST",
      body: JSON.stringify({ requestId: "not-a-uuid", content: "hi", media: [], targets: [], when: { mode: "draft" }, libi: { pieceId: "p1" } }),
    }));
    expect(res.status).toBe(400);
  });

  it("unauthorized → 401 needs_reconnect", async () => {
    stubService({}, { connected: false });
    const res = await listPosts(new Request("http://x/api/social/posts"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "needs_reconnect" });
  });

  it("a publish-now create that libi cannot confirm surfaces as needs-confirmation, not a retry", async () => {
    stubService({
      createPost: async () => {
        throw new SocialError("needs_confirmation", "a previous attempt may have already published this post", { status: 409 });
      },
    });
    const res = await createPost(new Request("http://x/api/social/posts", {
      method: "POST",
      headers: PAGE,
      body: JSON.stringify({ requestId: randomUUID(), content: "hi", media: [], targets: [], when: { mode: "now" }, libi: { pieceId: "p1" }, createdBy: "ui" }),
    }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "confirm_republish", message: "a previous attempt may have already published this post" });
  });

  it("a non-SocialError becomes a bare 500, never the raw error text — in the body OR the log", async () => {
    stubService({ listPosts: async () => { throw new Error("stack trace with something sensitive in it"); } });
    const res = await listPosts(new Request("http://x/api/social/posts"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "internal" });
    expect(JSON.stringify(body)).not.toContain("sensitive");
    // route-helpers.ts logs errShape(err) — name/code only — never `err.message`.
    const text = loggedText();
    expect(text).toContain("posts.list");
    expect(text).not.toContain("sensitive");
    expect(text).not.toContain("stack trace");
  });

  it.each([
    ["validation", 422, "bad input", { error: "validation", message: "bad input" }],
    ["not_found", 404, "gone", { error: "not_found" }],
    ["rate_limited", 429, "slow down", { error: "rate_limited", retryAt: null }],
    ["unsupported", 501, "no tool for this op", { error: "unsupported", message: "no tool for this op" }],
    // 403 and NOT `needs_reconnect`: a scope gap leaves the grant alone, and
    // a client that read `needs_reconnect` here would offer a reconnect that
    // fixes nothing.
    ["forbidden", 403, "Error: [403] insufficient_permissions", { error: "forbidden", message: "Error: [403] insufficient_permissions" }],
  ] as Array<[SocialErrorKind, number, string, Record<string, unknown>]>)(
    "every route maps a %s SocialError through socialErrorToResponse, not an invented status",
    async (kind, expectedStatus, message, expectedBody) => {
      stubService({ listPosts: async () => { throw new SocialError(kind, message, { status: expectedStatus }); } });
      const res = await listPosts(new Request("http://x/api/social/posts"));
      expect(res.status).toBe(expectedStatus);
      expect(await res.json()).toEqual(expectedBody);
    },
  );
});

/** Another route bundle's copy of `SocialError`: same name and fields, different class. The social
 *  service and its adapter are a globalThis singleton built from whichever route bundle loaded them
 *  first, so a route's `SocialError` class need not be the one the adapter threw with. */
function foreignSocialError(kind: SocialErrorKind, message: string, status: number): Error {
  return Object.assign(new Error(message), { name: "SocialError", kind, status });
}

describe("another bundle's copy of SocialError", () => {
  it("socialRoute maps it through socialErrorToResponse, not a bare 500", async () => {
    stubService({ listPosts: async () => { throw foreignSocialError("validation", "bad input", 422); } });
    const res = await listPosts(new Request("http://x/api/social/posts"));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "validation", message: "bad input" });
  });

  it("withAdapter still flips the service to needs-reconnect on the provider's 401", async () => {
    const markUnauthorized = vi.fn();
    const adapter = { providerId: "zernio", listPosts: async () => { throw foreignSocialError("unauthorized", "revoked", 401); } };
    __setSocialServiceForTests({
      status: async () => ({ providerId: "zernio" as const, connected: true, needsReconnect: false, scopes: [], connectedAt: "x" }),
      adapter: async () => adapter as unknown as SocialAdapter,
      markUnauthorized,
      reset() {},
      disconnect() {},
    });
    const res = await listPosts(new Request("http://x/api/social/posts"));
    expect(res.status).toBe(401);
    expect(markUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("the piece's posts read drops a post the provider answers not_found for", async () => {
    const [p] = getDb().insert(pieces).values({ name: "piece-posts-foreign" }).returning().all();
    insertLink({ providerId: "zernio", providerPostId: "ok2", pieceId: p.id, exportPath: null, requestId: null, createdBy: "ui" });
    insertLink({ providerId: "zernio", providerPostId: "gone3", pieceId: p.id, exportPath: null, requestId: null, createdBy: "ui" });
    stubService({
      getPost: async (id: string) => {
        if (id === "gone3") throw foreignSocialError("not_found", "no longer exists", 404);
        return { ...post, id: "ok2", createdAt: "2026-09-20T00:00:00.000Z" };
      },
    });
    const res = await piecePosts(new Request("http://x"), { params: Promise.resolve({ pieceId: p.id }) });
    expect(res.status).toBe(200);
    expect((await res.json()).posts.map((x: { id: string }) => x.id)).toEqual(["ok2"]);
    expect(linkForPost("zernio", "gone3")?.lastStatus).toBe("gone");
  });
});

describe("/api/social/posts/:postId", () => {
  it("GET decorates the post with its link row", async () => {
    stubService({ getPost: async () => post });
    const [p] = getDb().insert(pieces).values({ name: "one-post" }).returning().all();
    insertLink({ providerId: "zernio", providerPostId: post.id, pieceId: p.id, exportPath: null, requestId: null, createdBy: "ui" });
    const res = await getOnePost(new Request("http://x"), { params: Promise.resolve({ postId: post.id }) });
    const body = await res.json();
    noToken(body);
    expect(body.id).toBe(post.id);
    expect(body.link.pieceId).toBe(p.id);
  });

  it("PATCH updates the post, touches the link status and tracks the right action per when.mode", async () => {
    stubService({ updatePost: async () => ({ post: { ...post, status: "scheduled" }, deduped: false }) });
    const [p] = getDb().insert(pieces).values({ name: "patch-me" }).returning().all();
    insertLink({ providerId: "zernio", providerPostId: post.id, pieceId: p.id, exportPath: null, requestId: null, createdBy: "ui" });
    const res = await patchPost(
      new Request("http://x", { method: "PATCH", headers: PAGE, body: JSON.stringify({ requestId: randomUUID(), createdBy: "ui", when: { mode: "schedule", scheduledFor: "2026-10-01T00:00:00Z", timezone: "UTC" } }) }),
      { params: Promise.resolve({ postId: post.id }) },
    );
    expect(res.status).toBe(200);
    expect(tracked.calls).toEqual([["social_post_action", { provider: "zernio", action: "schedule" }]]);
    expect(linkForPost("zernio", post.id)?.lastStatus).toBe("scheduled");
  });

  it("PATCH forwards a libi metadata block (pieceId/requestId to preserve) straight to the adapter", async () => {
    let received: unknown;
    stubService({
      updatePost: async (_id: string, patch: unknown) => {
        received = patch;
        return { post: { ...post, status: "draft" }, deduped: false };
      },
    });
    const body = {
      requestId: randomUUID(),
      targets: [{ platform: "tiktok", accountId: "acct-tt", options: { platform: "tiktok", tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true, allowDuet: false, allowStitch: false, commercialContentType: "none", contentPreviewConfirmed: true, expressConsentGiven: true } } }],
      libi: { pieceId: "p1", requestId: "r-orig" },
    };
    const res = await patchPost(new Request("http://x", { method: "PATCH", headers: PAGE, body: JSON.stringify(body) }), {
      params: Promise.resolve({ postId: post.id }),
    });
    expect(res.status).toBe(200);
    expect((received as { libi?: { pieceId: string; requestId?: string } }).libi).toEqual({ pieceId: "p1", requestId: "r-orig" });
  });

  it("PATCH forwards the media to RE-SEND — an update that carries none loses it", async () => {
    let received: unknown;
    stubService({
      updatePost: async (_id: string, patch: unknown) => {
        received = patch;
        return { post, deduped: false };
      },
    });
    // The provider carries NO media over an update, and the URL a read echoes
    // back is the promoted one that 404s. So an update re-sends the ORIGINAL
    // upload URL, and the route has to let it through.
    const media = [{ url: "https://media.zernio.test/temp/1_e.mp4", type: "video", filename: "e.mp4", sizeBytes: 1210131, mimeType: "video/mp4" }];
    const res = await patchPost(
      new Request("http://x", { method: "PATCH", headers: PAGE, body: JSON.stringify({ requestId: randomUUID(), media, libi: { pieceId: "p1", mediaUrl: media[0].url } }) }),
      { params: Promise.resolve({ postId: post.id }) },
    );
    expect(res.status).toBe(200);
    expect((received as { media?: unknown[] }).media).toEqual(media);
    expect((received as { libi?: { mediaUrl?: string } }).libi?.mediaUrl).toBe(media[0].url);
  });

  it("PATCH with when.mode 'cancel' tracks action cancel", async () => {
    stubService({ updatePost: async () => ({ post: { ...post, status: "draft" }, deduped: false }) });
    const res = await patchPost(
      new Request("http://x", { method: "PATCH", headers: PAGE, body: JSON.stringify({ requestId: randomUUID(), when: { mode: "cancel" } }) }),
      { params: Promise.resolve({ postId: post.id }) },
    );
    expect(res.status).toBe(200);
    expect(tracked.calls).toEqual([["social_post_action", { provider: "zernio", action: "cancel" }]]);
  });

  it("DELETE removes the post and marks the link deleted", async () => {
    stubService({ deletePost: async () => {} });
    const [p] = getDb().insert(pieces).values({ name: "to-delete" }).returning().all();
    insertLink({ providerId: "zernio", providerPostId: "del1", pieceId: p.id, exportPath: null, requestId: null, createdBy: "ui" });
    const res = await deleteOnePost(new Request("http://x", { method: "DELETE", headers: PAGE }), { params: Promise.resolve({ postId: "del1" }) });
    expect(await res.json()).toEqual({ ok: true });
    expect(linkForPost("zernio", "del1")?.lastStatus).toBe("deleted");
    expect(tracked.calls).toEqual([["social_post_action", { provider: "zernio", action: "delete" }]]);
  });
});

describe("/api/social/posts/:postId/retry", () => {
  it("retries and tracks action retry", async () => {
    stubService({ retryPost: async () => ({ post, deduped: true }) });
    const res = await retryPost(new Request("http://x", { method: "POST", headers: PAGE }), { params: Promise.resolve({ postId: post.id }) });
    const body = await res.json();
    expect(body.post.id).toBe(post.id);
    expect(body.deduped).toBe(true);
    expect(tracked.calls).toEqual([["social_post_action", { provider: "zernio", action: "retry" }]]);
  });
});

describe("/api/social/posts/:postId/analytics", () => {
  it("answers the adapter's PostAnalytics", async () => {
    stubService({ postAnalytics: async () => ({ postId: post.id, syncStatus: "ready", perTarget: [] }) });
    const res = await postAnalytics(new Request("http://x"), { params: Promise.resolve({ postId: post.id }) });
    expect(await res.json()).toEqual({ postId: post.id, syncStatus: "ready", perTarget: [] });
  });
});

describe("/api/social/pieces/:pieceId/posts", () => {
  it("lists linked posts and drops one the provider now answers not_found for, marking its link gone", async () => {
    const [p] = getDb().insert(pieces).values({ name: "piece-posts" }).returning().all();
    insertLink({ providerId: "zernio", providerPostId: "ok1", pieceId: p.id, exportPath: null, requestId: null, createdBy: "ui" });
    insertLink({ providerId: "zernio", providerPostId: "gone1", pieceId: p.id, exportPath: null, requestId: null, createdBy: "ui" });
    stubService({
      getPost: async (id: string) => {
        if (id === "gone1") throw new SocialError("not_found", "no longer exists", { status: 404 });
        return { ...post, id: "ok1", createdAt: "2026-09-20T00:00:00.000Z" };
      },
    });
    const res = await piecePosts(new Request("http://x"), { params: Promise.resolve({ pieceId: p.id }) });
    const body = await res.json();
    noToken(body);
    expect(body.posts.map((x: { id: string }) => x.id)).toEqual(["ok1"]);
    expect(linkForPost("zernio", "gone1")?.lastStatus).toBe("gone");
  });

  it("answers an empty list without a chosen provider, never touching the adapter", async () => {
    setSocialSettings({ providerId: null, timezone: null, defaults: { instagramType: "reel", aiLabel: true }, pollSeconds: 30 });
    const res = await piecePosts(new Request("http://x"), { params: Promise.resolve({ pieceId: "whatever" }) });
    expect(await res.json()).toEqual({ posts: [] });
  });

  /**
   * QA finding: a link ALREADY marked gone (a previous load's not_found) was
   * re-fetched on every subsequent Posting tab load, logging a fresh
   * `posts_get_post` 404 each time for something already known dead. Once
   * `lastStatus` is "gone" it never comes back, so it must never be handed
   * to `getPost` again.
   */
  it("never re-fetches a link already marked gone", async () => {
    const [p] = getDb().insert(pieces).values({ name: "piece-posts-gone" }).returning().all();
    insertLink({ providerId: "zernio", providerPostId: "ok2", pieceId: p.id, exportPath: null, requestId: null, createdBy: "ui" });
    insertLink({ providerId: "zernio", providerPostId: "gone2", pieceId: p.id, exportPath: null, requestId: null, createdBy: "ui" });
    touchLinkStatus("zernio", "gone2", "gone");
    const getPost = vi.fn(async (id: string) => {
      if (id === "gone2") throw new SocialError("not_found", "no longer exists", { status: 404 });
      return { ...post, id: "ok2", createdAt: "2026-09-20T00:00:00.000Z" };
    });
    stubService({ getPost });
    const res = await piecePosts(new Request("http://x"), { params: Promise.resolve({ pieceId: p.id }) });
    const body = await res.json();
    noToken(body);
    expect(body.posts.map((x: { id: string }) => x.id)).toEqual(["ok2"]);
    expect(getPost).toHaveBeenCalledTimes(1);
    expect(getPost).toHaveBeenCalledWith("ok2");
  });
});

describe("/api/social/tiktok/creator-info", () => {
  it("400s without an accountId", async () => {
    const res = await creatorInfo(new Request("http://x/api/social/tiktok/creator-info"));
    expect(res.status).toBe(400);
  });

  it("answers the adapter's creator info for the given account", async () => {
    stubService({
      tiktokCreatorInfo: async (accountId: string) => ({
        accountId,
        privacyLevels: ["PUBLIC_TO_EVERYONE"],
        maxVideoSeconds: 600,
        canPostMore: true,
        interactions: {
          allow_comment: { required: true, default: true },
          allow_duet: { required: false, default: true },
          allow_stitch: { required: false, default: true },
        },
      }),
    });
    const res = await creatorInfo(new Request("http://x/api/social/tiktok/creator-info?accountId=acc1"));
    expect((await res.json()).accountId).toBe("acc1");
  });
});

describe("/api/social/ads", () => {
  it("is read-only and surfaces unavailable whenever it is non-empty, with the provider's message intact — even though accounts/campaigns are non-empty too", async () => {
    const message = "A connected Facebook account is required to manage Instagram ads.";
    stubService({
      listAccounts: async () => [account1, account2],
      listAdAccounts: async () => ({
        items: [{ id: "ad1", network: "meta", name: "Ad Acct", connected: true }],
        unavailable: [{ accountId: "acc2", message }],
      }),
      listCampaigns: async () => ({
        items: [{ id: "camp1", adAccountId: "ad1", network: "meta", name: "Camp", status: "active" }],
        unavailable: [{ accountId: "acc2", message }],
      }),
      listAds: async () => ({ items: [], unavailable: [{ accountId: "acc2", message }] }),
    });
    const body = await (await adsRoute()).json();
    noToken(body);
    expect(body.accounts).toHaveLength(1);
    expect(body.campaigns).toHaveLength(1);
    // Both reads failed the SAME account with the SAME message — merged to one line.
    expect(body.unavailable).toEqual([{ accountId: "acc2", message }]);
  });

  /**
   * QA 2026-09-21, finding 4. A token with the whole `ads` resource group
   * disabled fails BOTH reads for BOTH accounts, and the two 403 messages
   * are not byte-identical — each names its own endpoint — so the old
   * `(accountId, message)` key kept all four. The user saw the same error
   * four times, which reads as a malfunction, and React logged a duplicate
   * key for every account.
   */
  it("shows one line per account when the two ads reads fail it with DIFFERENT wording", async () => {
    const accountsMsg = "[403] This connector token has the 'ads' resource group disabled. GET /api/v1/ads/accounts requires it.";
    const campaignsMsg = "[403] This connector token has the 'ads' resource group disabled. GET /api/v1/ads/campaigns requires it.";
    stubService({
      listAccounts: async () => [account1, account2],
      listAdAccounts: async () => ({
        items: [],
        unavailable: [{ accountId: "acc1", message: accountsMsg }, { accountId: "acc2", message: accountsMsg }],
      }),
      listCampaigns: async () => ({
        items: [],
        unavailable: [{ accountId: "acc1", message: campaignsMsg }, { accountId: "acc2", message: campaignsMsg }],
      }),
      listAds: async () => ({ items: [], unavailable: [] }),
    });
    const body = await (await adsRoute()).json();
    expect(body.unavailable).toHaveLength(2);
    // And `accountId` is therefore unique — which is what the list keys on.
    expect(new Set(body.unavailable.map((u: { accountId: string }) => u.accountId)).size).toBe(2);
    // The provider's own words still reach the user verbatim.
    expect(body.unavailable[0].message).toBe(accountsMsg);
  });

  /**
   * QA 2026-09-22: the Ads tab lists individual ads, each with a "Piece"
   * button — so the read must say whose each ad is. A boost is placed by the
   * post it boosts (the post's own platform id), an ad-only one by libi's link
   * row, and one made outside libi is still listed, with no piece.
   */
  it("places each ad on its post and piece: boosted by platform id, linked by libi's own row, the rest as external", async () => {
    const [boostPiece] = getDb().insert(pieces).values({ name: "Desk setup" }).returning().all();
    const [darkPiece] = getDb().insert(pieces).values({ name: "Studio launch" }).returning().all();
    const published = {
      ...post,
      id: "post_reel",
      status: "published" as const,
      media: [{ url: "https://cdn.example/reel.mp4", type: "video" as const }],
      targets: [{ platform: "instagram" as const, accountId: "acc1", status: "published" as const, platformPostId: "ig_media_1" }],
    };
    insertLink({ providerId: "zernio", providerPostId: "post_reel", pieceId: boostPiece.id, exportPath: null, requestId: null, createdBy: "ui" });
    insertAdLink({ providerId: "zernio", providerAdId: "ad_dark", platformAdId: null, pieceId: darkPiece.id, createdBy: "agent" });
    const listPostsCalls: unknown[] = [];
    stubService({
      listAccounts: async () => [account1],
      listAdAccounts: async () => ({ items: [], unavailable: [] }),
      listCampaigns: async () => ({ items: [], unavailable: [] }),
      listPosts: async (f: unknown) => {
        listPostsCalls.push(f);
        return { posts: [published], page: 1, totalPages: 1 };
      },
      listAds: async () => ({
        items: [
          { id: "ad_boost", network: "metaads", name: "Reel boost", status: "active", effectiveInstagramMediaId: "ig_media_1" },
          { id: "ad_dark", network: "metaads", name: "Dark post", status: "active", thumbnailUrl: "https://cdn.example/dark.jpg" },
          { id: "ad_elsewhere", network: "metaads", name: "Made in Ads Manager", status: "paused" },
        ],
        unavailable: [],
      }),
    });

    const body = await (await adsRoute()).json();
    const byId = Object.fromEntries(body.ads.map((e: { ad: { id: string } }) => [e.ad.id, e]));
    expect(byId.ad_boost).toMatchObject({
      origin: "boosted",
      postId: "post_reel",
      pieceId: boostPiece.id,
      pieceName: "Desk setup",
      media: { url: "https://cdn.example/reel.mp4", type: "video" },
    });
    expect(byId.ad_dark).toMatchObject({
      origin: "linked",
      pieceId: darkPiece.id,
      pieceName: "Studio launch",
      media: { url: "https://cdn.example/dark.jpg", type: "image" },
    });
    expect(byId.ad_elsewhere.origin).toBe("external");
    expect(byId.ad_elsewhere.pieceId).toBeUndefined();
    // One scan of published posts places every boost — not one read per ad.
    expect(listPostsCalls).toHaveLength(1);
  });

  it("does not scan posts when no ad names one to boost", async () => {
    const listPosts = vi.fn(async () => ({ posts: [], page: 1, totalPages: 1 }));
    stubService({
      listAccounts: async () => [account1],
      listAdAccounts: async () => ({ items: [], unavailable: [] }),
      listCampaigns: async () => ({ items: [], unavailable: [] }),
      listPosts,
      listAds: async () => ({ items: [{ id: "ad_x", network: "metaads", name: "X", status: "active" }], unavailable: [] }),
    });
    const body = await (await adsRoute()).json();
    expect(body.ads).toHaveLength(1);
    expect(listPosts).not.toHaveBeenCalled();
  });

  it("has no write route: the module exports GET only", async () => {
    const mod: Record<string, unknown> = await import("@/app/api/social/ads/route");
    expect(mod.POST).toBeUndefined();
    expect(mod.PUT).toBeUndefined();
    expect(mod.PATCH).toBeUndefined();
    expect(mod.DELETE).toBeUndefined();
  });
});

describe("/api/social/links", () => {
  it("links a piece to a provider post directly", async () => {
    const [p] = getDb().insert(pieces).values({ name: "link-me" }).returning().all();
    const res = await linksRoute(new Request("http://x/api/social/links", { method: "POST", body: JSON.stringify({ pieceId: p.id, providerPostId: "direct1" }) }));
    expect(await res.json()).toEqual({ ok: true });
    expect(linkForPost("zernio", "direct1")).toMatchObject({ pieceId: p.id, createdBy: "agent" });
  });

  /** QA 2026-09-21, finding 9: linking is not authorship. One idempotent
   *  `libi.social_link_post` on a post the user composed in the UI flipped
   *  its row chip from "in libi" to "by agent". */
  it("never rewrites who made a post when it is linked again", async () => {
    const [p] = getDb().insert(pieces).values({ name: "mine" }).returning().all();
    insertLink({ providerId: "zernio", providerPostId: "ui1", pieceId: p.id, exportPath: "/a.mp4", requestId: "r1", createdBy: "ui" });
    const res = await linksRoute(
      new Request("http://x/api/social/links", {
        method: "POST",
        body: JSON.stringify({ pieceId: p.id, providerPostId: "ui1", createdBy: "agent", exportPath: "/b.mp4" }),
      }),
    );
    expect(await res.json()).toEqual({ ok: true });
    const row = linkForPost("zernio", "ui1")!;
    expect(row.createdBy).toBe("ui");
    // The rest of the row is still updated — this is about provenance only.
    expect(row.exportPath).toBe("/b.mp4");
  });

  it("404s linking a piece that does not exist", async () => {
    const res = await linksRoute(new Request("http://x/api/social/links", { method: "POST", body: JSON.stringify({ pieceId: "does-not-exist", providerPostId: "x1" }) }));
    expect(res.status).toBe(404);
  });

  it("409s with no provider chosen", async () => {
    setSocialSettings({ providerId: null, timezone: null, defaults: { instagramType: "reel", aiLabel: true }, pollSeconds: 30 });
    const res = await linksRoute(new Request("http://x/api/social/links", { method: "POST", body: JSON.stringify({ pieceId: "p1", providerPostId: "x1" }) }));
    expect(res.status).toBe(409);
  });

  it("reindex scans every page, links a post whose piece still exists and reports one whose piece is gone", async () => {
    const [p] = getDb().insert(pieces).values({ name: "reindex-target" }).returning().all();
    const known = { ...post, id: "known1", libi: { pieceId: p.id, requestId: "r1" } };
    const orphan = { ...post, id: "orphan1", libi: { pieceId: "missing-piece", requestId: "r2" } };
    stubService({ listPosts: async () => ({ posts: [known, orphan], page: 1, totalPages: 1 }) });
    const res = await linksRoute(new Request("http://x/api/social/links?action=reindex", { method: "POST" }));
    const body = await res.json();
    expect(body).toEqual({ scanned: 2, linked: 1, orphans: ["missing-piece"], truncated: false });
    expect(linkForPost("zernio", "known1")).toMatchObject({ pieceId: p.id, createdBy: "agent" });
    expect(linkForPost("zernio", "orphan1")).toBeNull();
  });

  it("reports truncated when the provider has more pages than one run walks", async () => {
    // A half-finished reindex must not read as a complete one: the caller only knows to
    // run it again if we say so. 41 claimed pages against a 40-page cap.
    let pagesFetched = 0;
    stubService({
      listPosts: async ({ page }: { page: number }) => {
        pagesFetched++;
        return { posts: [{ ...post, id: `p${page}`, libi: { pieceId: "missing-piece", requestId: `r${page}` } }], page, totalPages: 41 };
      },
    });
    const res = await linksRoute(new Request("http://x/api/social/links?action=reindex", { method: "POST" }));
    expect(await res.json()).toMatchObject({ scanned: 40, truncated: true });
    expect(pagesFetched).toBe(40);
  });
});

describe("/api/social/posts — the agent backstop", () => {
  const agentBody = (mode: string, pieceId: string) => JSON.stringify({
    requestId: randomUUID(), content: "hi", media: [], targets: [],
    when: mode === "draft" ? { mode: "draft" } : { mode: "now" },
    libi: { pieceId }, createdBy: "agent",
  });

  it("refuses a non-draft from an agent, and creates nothing", async () => {
    // libi.post_piece cannot express a publish, so this can only be reached by a
    // future agent-facing caller — which is exactly why the rule lives here and
    // not only in that tool's schema.
    let created = 0;
    stubService({ createPost: async () => { created++; return { post, deduped: false }; } });
    const [p] = getDb().insert(pieces).values({ name: "agent-backstop" }).returning().all();
    const res = await createPost(new Request("http://x/api/social/posts", { method: "POST", body: agentBody("now", p.id) }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("agent_draft_only");
    expect(created).toBe(0);
  });

  it("still allows an agent draft", async () => {
    stubService({ createPost: async () => ({ post, deduped: false }) });
    const [p] = getDb().insert(pieces).values({ name: "agent-backstop-draft" }).returning().all();
    const res = await createPost(new Request("http://x/api/social/posts", { method: "POST", body: agentBody("draft", p.id) }));
    expect(res.status).toBe(200);
  });

  /**
   * The rule FAILS CLOSED. `createdBy` used to default to `"ui"`, so a body
   * that simply omitted it — a future agent-facing caller, a replayed body, a
   * bug — walked past the check as the user. The restricted value is the
   * default now; libi's own UI says `"ui"` explicitly.
   */
  it("a body with NO createdBy is treated as an agent, not as the user", async () => {
    let created = 0;
    stubService({ createPost: async () => { created++; return { post, deduped: false }; } });
    const [p] = getDb().insert(pieces).values({ name: "agent-backstop-default" }).returning().all();
    const body = JSON.stringify({ requestId: randomUUID(), content: "hi", media: [], targets: [], when: { mode: "now" }, libi: { pieceId: p.id } });
    const res = await createPost(new Request("http://x/api/social/posts", { method: "POST", body }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("agent_draft_only");
    expect(created).toBe(0);
  });

  /**
   * And the backstop covers PATCH, which is the route that can take an
   * EXISTING draft public. `POST` alone left `{mode: "now"}` and
   * `{mode: "schedule"}` reachable by anyone on `/api/social/posts/:id`.
   * PATCH now also takes the browser-only checks, so a header-less agent
   * never reaches this rule at all; these requests carry the page's headers
   * to prove the rule still holds behind that check (defence in depth).
   */
  it.each([
    ["now", { mode: "now" }],
    ["schedule", { mode: "schedule", scheduledFor: "2030-01-01T09:00", timezone: "Asia/Bangkok" }],
  ])("PATCH refuses when.mode %s from an agent, and reaches no adapter", async (_label, when) => {
    let updates = 0;
    stubService({ updatePost: async () => { updates++; return { post, deduped: false }; } });
    const res = await patchPost(
      new Request("http://x", { method: "PATCH", headers: PAGE, body: JSON.stringify({ requestId: randomUUID(), when }) }),
      { params: Promise.resolve({ postId: post.id }) },
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("agent_draft_only");
    expect(updates).toBe(0);
    expect(tracked.calls).toEqual([]);
  });

  it.each([
    ["cancel", { mode: "cancel" }],
    ["draft", { mode: "draft" }],
  ])("PATCH still lets an agent move a post to %s, and an edit with no `when` through", async (_label, when) => {
    stubService({ updatePost: async () => ({ post, deduped: false }) });
    for (const body of [{ requestId: randomUUID(), when }, { requestId: randomUUID(), content: "edited" }]) {
      const res = await patchPost(
        new Request("http://x", { method: "PATCH", headers: PAGE, body: JSON.stringify(body) }),
        { params: Promise.resolve({ postId: post.id }) },
      );
      expect(res.status).toBe(200);
    }
  });

  it("`createdBy` never reaches the adapter — it is the route's own gate, not part of the patch", async () => {
    let received: Record<string, unknown> | undefined;
    stubService({ updatePost: async (_id: string, patch: Record<string, unknown>) => { received = patch; return { post, deduped: false }; } });
    const res = await patchPost(
      new Request("http://x", { method: "PATCH", headers: PAGE, body: JSON.stringify({ requestId: randomUUID(), createdBy: "ui", content: "edited" }) }),
      { params: Promise.resolve({ postId: post.id }) },
    );
    expect(res.status).toBe(200);
    expect(received).toBeDefined();
    expect(Object.keys(received!)).not.toContain("createdBy");
  });
});

describe("/api/social/validate", () => {
  it("proxies to the adapter's validatePost", async () => {
    stubService({ validatePost: async () => [{ platform: "instagram", ok: true, errors: [] }] });
    const res = await validateRoute(new Request("http://x/api/social/validate", {
      method: "POST",
      body: JSON.stringify({ requestId: randomUUID(), content: "hi", media: [], targets: [], when: { mode: "draft" }, libi: { pieceId: "p1" } }),
    }));
    expect(await res.json()).toEqual([{ platform: "instagram", ok: true, errors: [] }]);
  });

  it("dryRun goes to dryRunTikTok instead — a different provider call that creates nothing", async () => {
    let validateCalled = false;
    stubService({
      validatePost: async () => {
        validateCalled = true;
        return [];
      },
      dryRunTikTok: async () => ({ canPublish: false, perAccount: [{ accountId: "acct-tt", canPublish: false, reason: "daily cap" }] }),
    });
    const res = await validateRoute(new Request("http://x/api/social/validate", {
      method: "POST",
      body: JSON.stringify({
        requestId: randomUUID(),
        content: "hi",
        media: [],
        targets: [],
        when: { mode: "now" },
        libi: { pieceId: "p1" },
        dryRun: true,
      }),
    }));
    expect(await res.json()).toEqual({
      dryRun: true,
      canPublish: false,
      perAccount: [{ accountId: "acct-tt", canPublish: false, reason: "daily cap" }],
    });
    expect(validateCalled).toBe(false);
  });
});

describe("/api/social/request-id", () => {
  const url = (q: string) => new Request(`http://x/api/social/request-id?${q}`);

  it("adopts the piece's OPEN intent, so a reopened composer keeps the post's identity", async () => {
    const [p] = getDb().insert(pieces).values({ name: "open-intent" }).returning().all();
    // A publish-now whose outcome libi never learned.
    beginPostIntent({ providerId: "zernio", requestId: "r-open", pieceId: p.id, mode: "now" });
    markPostIntentUnknown("zernio", "r-open");
    const body = await (await requestIdRoute(url(`pieceId=${p.id}`))).json();
    expect(body).toEqual({ requestId: "r-open", source: "intent" });
  });

  it("an intent whose post IS known is not adopted — that post exists, and this is a new one", async () => {
    const [p] = getDb().insert(pieces).values({ name: "linked-intent" }).returning().all();
    beginPostIntent({ providerId: "zernio", requestId: "r-done", pieceId: p.id, mode: "draft" });
    resolvePostIntent("zernio", "r-done", "post_1");
    const body = await (await requestIdRoute(url(`pieceId=${p.id}`))).json();
    expect(body.source).toBe("fresh");
    expect(body.requestId).not.toBe("r-done");
    expect(String(body.requestId)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("the post being edited answers with its own link row's id", async () => {
    const [p] = getDb().insert(pieces).values({ name: "edit-me" }).returning().all();
    insertLink({ providerId: "zernio", providerPostId: "post_1", pieceId: p.id, exportPath: null, requestId: "r-link", createdBy: "ui" });
    const body = await (await requestIdRoute(url(`pieceId=${p.id}&postId=post_1`))).json();
    expect(body).toEqual({ requestId: "r-link", source: "link" });
  });
});
