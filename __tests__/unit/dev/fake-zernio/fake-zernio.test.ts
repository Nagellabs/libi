/**
 * The fake Zernio server, driven over REAL streamable HTTP by the production
 * client (`connectProviderMcp`) and the production adapter.
 *
 * Every assertion here is about the fake being a FAITHFUL LIAR. A test that
 * would also pass against a permissive fake proves nothing: the permissive one
 * hid three Critical defects for two whole tasks, and a fourth survived until
 * somebody called the live server. So the first block below is the strictness
 * itself — the curated `tools/list`, the refused direct call, the rejected
 * unknown argument, the `Unknown tool` text, the Python-repr envelope — and
 * only then the behaviours built on top of it.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { startFakeZernioHttp, type FakeZernioHttp } from "@/mcp/dev/fake-zernio/http";
import { createFakeState } from "@/mcp/dev/fake-zernio/state";
import { CURATED_TOOLS, FULL_SHAPED_TOOLS, ZERNIO_INPUT_SCHEMAS } from "@/mcp/dev/fake-zernio/live-surface";
import { LISTED_TOOL_DEFS } from "@/mcp/dev/fake-zernio/schemas";
import { fakeZernioRecordPath } from "@/mcp/dev/fake-zernio/recorder";
import { HANDLERS, SERVED_TOOLS } from "@/mcp/dev/fake-zernio/tools";
import { connectProviderMcp, type ProviderMcp } from "@/lib/social/mcp-client";
import { ZernioAdapter } from "@/lib/social/providers/zernio/adapter";
import { ZERNIO_LOSSY_TOOLS } from "@/lib/social/providers/zernio/ops";
import { toCreateBody, toValidateBody } from "@/lib/social/providers/zernio/normalize";
import { SocialError } from "@/lib/social/errors";
import type { CreatePostInput } from "@/lib/social/types";

const IG = "6aae6b468d284ffb211ade1e";
const TT = "6aae6ba98d284ffb211ae03a";
const PIECE_ID = "piece_1";

let home: string;
const servers: FakeZernioHttp[] = [];
const clients: ProviderMcp[] = [];

async function boot(cfg: Parameters<typeof createFakeState>[0] = null): Promise<{ fake: FakeZernioHttp; mcp: ProviderMcp; adapter: ZernioAdapter }> {
  const fake = await startFakeZernioHttp({ state: createFakeState(cfg) });
  servers.push(fake);
  const mcp = await connectProviderMcp({ url: fake.url, bearer: "test-mode" });
  clients.push(mcp);
  return { fake, mcp, adapter: new ZernioAdapter(mcp, { aiLabelDefault: true }) };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fakezernio-"));
  process.env.LIBI_HOME = home;
  const db = createTestDb();
  // `createPost` writes an intent row keyed on the piece before it sends anything.
  seedPiece(db, { id: PIECE_ID });
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const s of servers.splice(0)) await s.close().catch(() => {});
  resetTestDb();
  rmSync(home, { recursive: true, force: true });
});

afterAll(() => {
  delete process.env.LIBI_HOME;
});

const create = (over: Partial<CreatePostInput> = {}): CreatePostInput => ({
  requestId: `r-${Math.random().toString(16).slice(2)}`,
  content: "The desk setup that finally works",
  media: [{ url: "https://cdn.example/export.mp4", type: "video" }],
  targets: [{ platform: "instagram", accountId: IG, options: { platform: "instagram", instagram: { contentType: "reel" } } }],
  when: { mode: "draft" },
  libi: { pieceId: PIECE_ID },
  ...over,
});

const tiktokTarget: CreatePostInput["targets"][number] = {
  platform: "tiktok",
  accountId: TT,
  options: {
    platform: "tiktok",
    tiktok: {
      privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true, allowDuet: false, allowStitch: false,
      commercialContentType: "none", contentPreviewConfirmed: true, expressConsentGiven: true,
    },
  },
};

// ---------------------------------------------------------------------------
// The strictness. None of these pass against a permissive fake.
// ---------------------------------------------------------------------------

describe("fake zernio — the four lies it must tell", () => {
  it("lists ONLY the curated tools; every full-shaped one is absent", async () => {
    const { mcp } = await boot();
    const names = await mcp.listToolNames();
    expect([...names].sort()).toEqual([...CURATED_TOOLS].sort());
    for (const name of FULL_SHAPED_TOOLS) expect(names, name).not.toContain(name);
  });

  it("serves an unlisted full-shaped tool through call_tool, and REFUSES the same name directly", async () => {
    const { fake, mcp } = await boot();
    // Through the hop, as `mcp-client.ts#call` routes an unlisted name.
    const listed = await mcp.call<{ accounts: unknown[] }>("accounts_list_accounts", {});
    expect(listed.accounts).toHaveLength(2);

    // Directly — which is what a resolver preferring the LISTED name would do.
    // A second client is used because the first memoized the tool list and
    // would take the hop again on its own.
    const direct = await rawCall(fake.url, "accounts_list_accounts", {});
    expect(direct.isError).toBe(true);
    expect(text(direct)).toBe("Unknown tool: 'accounts_list_accounts'");
  });

  it("rejects an unknown argument with the live pydantic text, and creates nothing", async () => {
    const { fake, mcp } = await boot();
    // The exact call the old adapter made: an idempotency `headers` slot that
    // does not exist on any generated Zernio tool.
    await expect(
      mcp.call("posts_create_post", { content: "hi", platforms: [], headers: { "x-request-id": "r1" } }),
    ).rejects.toThrow(/1 validation error for call\[posts_create_post\]\nheaders {2}Unexpected keyword argument/);
    expect(fake.state.posts.size).toBe(0);
  });

  it("rejects a camelCase write body — the top level is snake_case", async () => {
    const { fake, mcp } = await boot();
    await expect(mcp.call("posts_create_post", { content: "hi", mediaItems: [], isDraft: true })).rejects.toThrow(
      /mediaItems {2}Unexpected keyword argument/,
    );
    expect(fake.state.posts.size).toBe(0);
  });

  it("answers `Unknown tool: '<name>'` for a name it does not serve — including posts_retry_post", async () => {
    const { mcp } = await boot();
    for (const name of ["posts_retry_post", "posts_quick_create"]) {
      await expect(mcp.call(name, { post_id: "x" })).rejects.toThrow(`Unknown tool: '${name}'`);
    }
  });

  it("answers in the `{result: \"<Python repr>\"}` envelope, and libi's parser is what reads it", async () => {
    const { fake, mcp } = await boot();
    const raw = await rawCall(fake.url, "accounts_get_account_health", { account_id: IG });
    const envelope = JSON.parse(text(raw)) as { result: string };
    // Python's repr, not JSON: single quotes, True/False/None.
    expect(envelope.result.startsWith("{'accountId':")).toBe(true);
    expect(envelope.result).toContain("'valid': True");
    expect(envelope.result).toContain("'messagingRestriction': None");
    expect(() => JSON.parse(envelope.result)).toThrow();
    // And the production seam reads exactly that.
    const health = await mcp.call<{ tokenStatus: { valid: boolean } }>("accounts_get_account_health", { account_id: IG });
    expect(health.tokenStatus.valid).toBe(true);
  });

  it("makes the CURATED convenience tools answer prose, so an op that resolves to one fails loudly", async () => {
    const { mcp } = await boot();
    for (const lossy of ZERNIO_LOSSY_TOOLS) {
      if (lossy !== "accounts_list" && lossy !== "posts_list") continue;
      await expect(mcp.call(lossy, {})).rejects.toThrow(/answered in a format libi cannot read/);
    }
  });

  /**
   * Found by this fake, in this task: `validatePost` used to send the whole
   * `toCreateBody` output to `validate_post`, which accepts three arguments
   * and nothing else. Live, that call fails outright — so validation never
   * ran. `toValidateBody` is the fix; this is the guard.
   */
  it("would have refused the OLD validate_post body — the whole create body", async () => {
    const { mcp } = await boot();
    const createBody = toCreateBody(create(), true);
    expect(Object.keys(createBody)).toContain("tags");
    await expect(mcp.call("validate_post", createBody)).rejects.toThrow(/tags {2}Unexpected keyword argument/);
    await expect(mcp.call("validate_post", toValidateBody(create(), true))).resolves.toBeTruthy();
  });

  it("serves every reachable tool the recording names, and nothing it does not", () => {
    const served = Object.keys(HANDLERS).sort();
    // `call_tool` is the dispatcher itself, handled in the server, not a handler.
    expect(served).toEqual([...CURATED_TOOLS.filter((n) => n !== "call_tool"), ...FULL_SHAPED_TOOLS].sort());
    expect(SERVED_TOOLS.sort()).toEqual(served);
  });

  it("advertises what it enforces: every listed schema matches the recording, additionalProperties false", () => {
    for (const def of LISTED_TOOL_DEFS) {
      const recorded = ZERNIO_INPUT_SCHEMAS[def.name];
      expect(recorded, def.name).toBeDefined();
      expect(Object.keys(def.inputSchema.properties).sort(), def.name).toEqual([...recorded.properties].sort());
      expect(def.inputSchema.required ?? [], def.name).toEqual([...(recorded.required ?? [])]);
      expect(def.inputSchema.additionalProperties, def.name).toBe(false);
    }
    expect(LISTED_TOOL_DEFS.map((d) => d.name).sort()).toEqual([...CURATED_TOOLS].sort());
  });
});

// ---------------------------------------------------------------------------
// The awkward real shapes
// ---------------------------------------------------------------------------

describe("fake zernio — the awkward live shapes", () => {
  it("gives a DRAFT platform rows with a meaningless scheduledFor and status pending, which never becomes a schedule", async () => {
    const { fake, adapter } = await boot();
    const { post } = await adapter.createPost(create());
    expect(post.status).toBe("draft");
    expect(post.scheduledFor).toBeUndefined();
    expect(post.targets[0].status).toBe("pending");
    // The raw row DOES carry one — that is the trap `toPost` absorbs.
    const rows = (fake.state.posts.get(post.id)!.platforms as Array<Record<string, unknown>>);
    expect(typeof rows[0].scheduledFor).toBe("string");
    expect(rows[0].status).toBe("pending");
  });

  it("answers `platforms[].accountId` as an OBJECT on the posts endpoints and a STRING on analytics", async () => {
    const { mcp, adapter } = await boot();
    const { post } = await adapter.createPost(create({ when: { mode: "now" } }));
    const raw = await mcp.call<{ post: { platforms: Array<{ accountId: unknown }> } }>("posts_get_post", { post_id: post.id });
    expect(typeof raw.post.platforms[0].accountId).toBe("object");
    expect((raw.post.platforms[0].accountId as { _id: string })._id).toBe(IG);

    const analytics = await mcp.call<{ platformAnalytics: Array<{ accountId: unknown }> }>("analytics_get_analytics", { post_id: post.id });
    expect(typeof analytics.platformAnalytics[0].accountId).toBe("string");
    expect(analytics.platformAnalytics[0].accountId).toBe(IG);
    // Both normalize to the same id.
    expect(post.targets[0].accountId).toBe(IG);
  });

  it("round-trips `metadata` but cannot filter on it — the argument does not exist", async () => {
    const { mcp, adapter } = await boot();
    const input = create();
    const { post } = await adapter.createPost(input);
    expect(post.libi?.pieceId).toBe(PIECE_ID);
    expect(post.libi?.requestId).toBe(input.requestId);
    await expect(mcp.call("posts_list_posts", { page: 1, limit: 10, metadata: { libi: { requestId: input.requestId } } })).rejects.toThrow(
      /metadata {2}Unexpected keyword argument/,
    );
  });

  it("refuses posts_list_posts unless page and limit are sent together", async () => {
    const { mcp } = await boot();
    await expect(mcp.call("posts_list_posts", { page: 1 })).rejects.toThrow(/page and limit must be provided together/);
    await expect(mcp.call("posts_list_posts", { page: 1, limit: 10 })).resolves.toBeTruthy();
  });

  it("answers 'still syncing' before it answers numbers, and never zeros", async () => {
    const { adapter } = await boot({ analyticsPendingCalls: 1 });
    const { post } = await adapter.createPost(create({ when: { mode: "now" } }));
    const first = await adapter.postAnalytics(post.id);
    expect(first.syncStatus).toBe("pending");
    expect(first.perTarget.every((t) => t.impressions === undefined)).toBe(true);
    const second = await adapter.postAnalytics(post.id);
    expect(second.syncStatus).toBe("ready");
    expect(second.perTarget[0].impressions).toBeGreaterThan(0);
  });

  it("sends `lastUpdated` as \"YYYY-MM-DD HH:MM:SS\" with no zone, which normalizes as UTC", async () => {
    const { mcp, adapter } = await boot({ analyticsPendingCalls: 0 });
    const { post } = await adapter.createPost(create({ when: { mode: "now" } }));
    const raw = await mcp.call<{ lastUpdated: string }>("analytics_get_analytics", { post_id: post.id });
    expect(raw.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const normalized = await adapter.postAnalytics(post.id);
    expect(normalized.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  /**
   * The fake sends the live text VERBATIM:
   *
   *     Error: [422] A connected Facebook account is required to manage
   *     Instagram ads. (code: linked_account_required)
   *
   * `redactSecrets` (mcp-client.ts) used to treat ANY bare `code: <value>` as
   * the OAuth authorization code, so Zernio's reason code was replaced by
   * `[redacted]` in every provider message that carried one — this test used
   * to pin that loss. The pattern is now narrowed to the two SYNTACTIC forms
   * an OAuth code actually arrives in (`code=…` in a URL/query string,
   * `"code":"…"` in JSON); a bare, unquoted `code:` with a colon-space is
   * provider prose and is left alone. The message now reaches the UI
   * verbatim, as the adapter's own doc comment says it should.
   */
  it("answers an ads read for an account with no linked Facebook with the provider's own 422, verbatim", async () => {
    const { mcp, adapter } = await boot();
    const raw = await mcp.call("ad_accounts_list_ad_accounts", { account_id: IG }).catch((e: SocialError) => e);
    expect((raw as SocialError).kind).toBe("validation");

    const accounts = await adapter.listAccounts();
    const ads = await adapter.listAdAccounts(accounts);
    expect(ads.items).toEqual([]);
    const ig = ads.unavailable.find((u) => u.accountId === IG)!;
    expect(ig.message).toBe("Error: [422] A connected Facebook account is required to manage Instagram ads. (code: linked_account_required)");
  });

  it("serves the ads tree when a scenario connects one", async () => {
    const { adapter } = await boot({ adsEnabled: true });
    const accounts = await adapter.listAccounts();
    const ads = await adapter.listAdAccounts(accounts);
    expect(ads.items.map((a) => a.id)).toEqual(["act_1234"]);
    const campaigns = await adapter.listCampaigns(accounts);
    expect(campaigns.items.map((c) => c.status)).toEqual(["active", "paused"]);
  });

  it("refuses an ads read with no account_id at all — ad accounts are per connected account", async () => {
    const { mcp } = await boot();
    await expect(mcp.call("ad_accounts_list_ad_accounts", {})).rejects.toThrow(/account_id {2}Field required/);
  });

  it("names the candidates when a write omits account_id and two accounts share the platform", async () => {
    const { mcp } = await boot({ twoInstagramAccounts: true });
    // The candidate list — the part the agent has to read and retry with —
    // survives, and so does the reason code now that `redactSecrets` no
    // longer treats every bare `code: <value>` as a credential (see the ads
    // test above): both halves of `(code: ambiguous_account)` reach the
    // caller verbatim.
    await expect(mcp.call("posts_create_post", { content: "hi", platforms: [{ platform: "instagram" }] })).rejects.toThrow(
      /account_id is required for instagram: candidates 6aae6b468d284ffb211ade1e \(@nagellabs\), 6aae6b468d284ffb211ade1f \(@nagellabs\.studio\) \(code: ambiguous_account\)/,
    );
  });

  it("offers a second TikTok privacy level only when the scenario opts in", async () => {
    const { adapter } = await boot({ multiLevelTikTokPrivacy: true });
    expect((await adapter.tiktokCreatorInfo(TT)).privacyLevels).toEqual(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS"]);
  });
});

// ---------------------------------------------------------------------------
// The behaviours the feature is built on
// ---------------------------------------------------------------------------

describe("fake zernio — end to end through the adapter", () => {
  it("mirrors the surface: accounts, health, creator info, presign + a real PUT", async () => {
    const { fake, adapter } = await boot();
    const accounts = await adapter.listAccounts();
    expect(accounts.map((a) => a.platform).sort()).toEqual(["instagram", "tiktok"]);
    expect(accounts[0].health?.status).toBe("healthy");
    expect((await adapter.accountHealth(IG))?.status).toBe("healthy");
    // Live: this account offers exactly ONE privacy level
    // (`.superpowers/sdd/zernio-live-shapes.md`) — a fake that defaults to a richer
    // (multi-level) picker would hide the bug this fixture exists to catch.
    expect((await adapter.tiktokCreatorInfo(TT)).privacyLevels).toEqual(["PUBLIC_TO_EVERYONE"]);

    const pre = await adapter.presign({ filename: "e.mp4", contentType: "video/mp4", sizeBytes: 3 });
    expect((await fetch(pre.uploadUrl, { method: "PUT", body: "abc" })).status).toBe(200);
    expect(await (await fetch(pre.publicUrl)).text()).toBe("abc");
    expect(fake.state.uploads.size).toBe(1);
  });

  it("draft → schedule → back to draft → publish now, with per-target rows and URLs", async () => {
    const { adapter } = await boot();
    const { post } = await adapter.createPost(create());
    expect(post.status).toBe("draft");

    const scheduled = await adapter.updatePost(post.id, { requestId: "r", when: { mode: "schedule", scheduledFor: "2030-01-01T09:00:00", timezone: "Asia/Bangkok" } });
    expect(scheduled.post.status).toBe("scheduled");
    expect(scheduled.post.scheduledFor).toBe("2030-01-01T09:00:00");

    expect((await adapter.updatePost(post.id, { requestId: "r", when: { mode: "cancel" } })).post.status).toBe("draft");

    const published = await adapter.updatePost(post.id, { requestId: "r", when: { mode: "now" } });
    expect(published.post.status).toBe("published");
    expect(published.post.targets[0]).toMatchObject({ status: "published", url: expect.stringContaining("instagram.com") });

    // A published post is immutable, both ways.
    await expect(adapter.updatePost(post.id, { requestId: "r", content: "nope" })).rejects.toThrow(/cannot be updated/);
    await expect(adapter.deletePost(post.id)).rejects.toThrow(/cannot be deleted/);
  });

  it("reads a post back, lists it by status, and keeps ONE state across two clients", async () => {
    const { fake, adapter } = await boot();
    const { post } = await adapter.createPost(create());
    expect((await adapter.getPost(post.id)).id).toBe(post.id);
    expect((await adapter.listPosts({ status: ["draft"] })).posts.map((p) => p.id)).toContain(post.id);

    // A SECOND connection — the agent's, say — sees the same post. That is the
    // whole reason this fake is HTTP and not a stdio child per session.
    const second = await connectProviderMcp({ url: fake.url, bearer: "test-mode" });
    clients.push(second);
    const seen = await second.call<{ post: { _id: string } }>("posts_get_post", { post_id: post.id });
    expect(seen.post._id).toBe(post.id);
  });

  it("fails one target and leaves the other published, then retries into a clean publish", async () => {
    const { adapter } = await boot({ failTarget: { platform: "tiktok", errorMessage: "Selected privacy level 'SELF_ONLY' is not available for this creator" } });
    const input = create({
      targets: [create().targets[0], tiktokTarget],
      when: { mode: "draft" },
    });
    const { post } = await adapter.createPost(input);
    await expect(adapter.updatePost(post.id, { requestId: "r", when: { mode: "now" } })).resolves.toMatchObject({
      post: { status: "partial", targets: expect.arrayContaining([expect.objectContaining({ status: "failed", error: expect.stringContaining("SELF_ONLY") })]) },
    });
    const retried = await adapter.retryPost(post.id);
    expect(retried.post.status).toBe("published");
    expect(retried.post.targets.every((t) => t.status === "published")).toBe(true);
  });

  it("rejects a second create as duplicate content, and the adapter reports it as deduped", async () => {
    const { adapter } = await boot({ duplicateOnSecondCreate: true });
    const first = await adapter.createPost(create());
    expect(first.deduped).toBe(false);
    const second = await adapter.createPost(create({ content: first.post.content }));
    expect(second.deduped).toBe(true);
    expect(second.post.id).toBe(first.post.id);
  });

  it("answers a rate limit once, as a retryable SocialError carrying the wait", async () => {
    const { adapter } = await boot({ rateLimitOnce: true });
    const err = await adapter.createPost(create()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialError);
    expect((err as SocialError).kind).toBe("rate_limited");
    expect((err as SocialError).retryAt).toBeTruthy();
  });

  it("runs a TikTok dry run without creating anything, and refuses one with no TikTok target", async () => {
    const { fake, adapter } = await boot();
    const dry = await adapter.dryRunTikTok(create({ targets: [tiktokTarget] }));
    expect(dry.canPublish).toBe(true);
    expect(dry.perAccount[0].accountId).toBe(TT);
    expect(fake.state.posts.size).toBe(0);
    await expect(adapter.dryRunTikTok(create())).rejects.toThrow(/needs at least one TikTok target/);
  });

  it("validates a post — with the THREE arguments validate_post accepts and nothing else", async () => {
    const { adapter } = await boot();
    const results = await adapter.validatePost(create());
    expect(results).toEqual([{ platform: "instagram", ok: true, errors: [] }]);
  });

  it("selfCheck finds every op, because call_tool reaches the unlisted ones", async () => {
    const { adapter } = await boot();
    expect(await adapter.selfCheck()).toEqual({ ok: true, missing: [] });
  });
});

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

describe("fake zernio — the recording the skill-eval assertions read", () => {
  it("writes one line per call under <home>/test-mode/zernio-calls.jsonl, with the hop and the ids", async () => {
    const { adapter } = await boot();
    const input = create();
    const { post } = await adapter.createPost(input);
    await adapter.updatePost(post.id, { requestId: "r", when: { mode: "now" } });

    const lines = readFileSync(fakeZernioRecordPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const created = lines.find((l) => l.tool === "posts_create_post")!;
    expect(created.via).toBe("call_tool");
    expect(created.post_id).toBe(post.id);
    expect(created.request_id).toBe(input.requestId);
    const updated = lines.find((l) => l.tool === "posts_update_post")!;
    expect(updated.post_id).toBe(post.id);
    expect(lines.every((l) => typeof l.ts === "string")).toBe(true);
  });

  it("records a REFUSED call too — an agent reaching for a tool that does not exist is a finding", async () => {
    const { mcp } = await boot();
    await expect(mcp.call("posts_retry_post", { post_id: "x" })).rejects.toThrow();
    const lines = readFileSync(fakeZernioRecordPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.some((l) => l.tool === "posts_retry_post" && l.rejected === true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helpers: a raw JSON-RPC call, bypassing the client's unlisted-name routing.
// ---------------------------------------------------------------------------

interface RawResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

function text(res: RawResult): string {
  return res.content?.find((c) => c.type === "text")?.text ?? "";
}

/** One `tools/call` over the wire, with the name exactly as given. */
async function rawCall(url: string, name: string, args: Record<string, unknown>): Promise<RawResult> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const init = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } }),
  });
  const sessionId = init.headers.get("mcp-session-id");
  if (sessionId) headers["mcp-session-id"] = sessionId;
  await init.text();
  await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.text();
  const line = body.split("\n").find((l) => l.startsWith("data: ")) ?? body;
  const frame = JSON.parse(line.startsWith("data: ") ? line.slice(6) : line) as { result?: RawResult };
  return frame.result ?? {};
}

describe("music catalog (fake)", () => {
  it("defaults to the live states: TikTok Business lane answers tracks, Instagram-Login refuses", async () => {
    const { adapter } = await boot();
    const tt = await adapter.musicCatalog(TT, { platform: "tiktok" });
    expect("tracks" in tt && tt.tracks.some((t) => t.title === "Espresso" && t.artist === "Sabrina Carpenter")).toBe(true);
    expect(await adapter.musicCatalog(IG, { platform: "instagram" })).toMatchObject({ unavailable: { reason: "needs_facebook_login" } });
  });
  it("the knobs flip them", async () => {
    const { adapter } = await boot({ tiktokLane: "developer", instagramFacebookLogin: true });
    expect(await adapter.musicCatalog(TT, { platform: "tiktok" })).toMatchObject({ unavailable: { reason: "not_business" } });
    const ig = await adapter.musicCatalog(IG, { platform: "instagram", query: "espresso" });
    expect("tracks" in ig && ig.tracks.map((t) => t.title)).toEqual(["Espresso"]);
  });
  it("instagram_get_instagram_audio checks the account and its platform like its siblings", async () => {
    const { fake } = await boot({ instagramFacebookLogin: true });
    const get = (args: Record<string, unknown>) => rawCall(fake.url, "call_tool", { name: "instagram_get_instagram_audio", arguments: args });
    expect(text(await get({ account_id: "nope", audio_id: "x" }))).toMatch(/^Error: \[404\] Account nope not found \(code: not_found\)/);
    expect(text(await get({ account_id: TT, audio_id: "x" }))).toMatch(/^Error: \[422\] This account is not an Instagram account\./);
  });
});
