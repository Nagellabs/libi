import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod/v3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  connectProviderMcp,
  holdProviderMcp,
  observeRetryAfter,
  stripScopeChallenge,
  timeoutForTool,
  toSocialError,
  redactSecrets,
  CALL_TIMEOUT_MS,
  SLOW_CALL_TIMEOUT_MS,
  type ProviderMcp,
} from "@/lib/social/mcp-client";
import {
  actionMatches,
  callOp,
  isUnknownToolError,
  recoverOp,
  resolveOps,
  resolveOpsFromServer,
  toolForOp,
  toolNamesFromSearch,
  SEARCH_TOOLS,
  ZERNIO_OPS,
  ZERNIO_OP_IDS,
  ZERNIO_LOSSY_TOOLS,
  type ZernioOp,
} from "@/lib/social/providers/zernio/ops";
import { CURATED_TOOLS, REACHABLE_TOOLS, unknownToolText } from "@/__tests__/helpers/zernio-fake";
import { isRetryable, SocialError } from "@/lib/social/errors";
import { SocialTokenStore, type StoredGrant } from "@/lib/social/token-store";
import { LibiOAuthClientProvider } from "@/lib/social/oauth/client-provider";
import { serverLogger } from "@/lib/logger";

/** The credential a leak would carry. Nothing this feature logs or returns may contain it. */
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.SUPERSECRETGRANT.c2lnbmF0dXJl";

type ToolImpl = (args: Record<string, unknown>) => { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** A stand-in for the provider's hosted server: the tools it lists, plus the
 *  generic `call_tool` that reaches everything it does not list. */
async function fakeServer(opts: {
  listed?: string[];
  /** Answers by tool name; `call_tool` dispatches into the same table. */
  impls?: Record<string, ToolImpl>;
  withCallTool?: boolean;
  withSearch?: boolean;
  /** What `search_tools` answers, by query. */
  searchHits?: Record<string, string[]>;
  calls?: string[];
} = {}): Promise<Transport> {
  const listed = opts.listed ?? ["accounts_list", "boom"];
  const impls: Record<string, ToolImpl> = {
    accounts_list: () => ({ content: [{ type: "text", text: JSON.stringify({ accounts: [{ _id: "a1" }] }) }] }),
    boom: () => ({ isError: true, content: [{ type: "text", text: "HTTP 429 Too Many Requests; Retry-After: 30" }] }),
    ...opts.impls,
  };
  const server = new McpServer({ name: "zernio-fake", version: "0" });
  for (const name of listed) {
    server.registerTool(name, { inputSchema: {} }, async (args: Record<string, unknown>) => {
      opts.calls?.push(name);
      return (impls[name] ?? (() => ({ content: [{ type: "text" as const, text: "{}" }] })))(args);
    });
  }
  if (opts.withCallTool !== false) {
    server.registerTool(
      "call_tool",
      { inputSchema: { name: z.string(), arguments: z.record(z.unknown()).optional() } },
      async ({ name, arguments: inner }) => {
        opts.calls?.push(`call_tool:${name}`);
        const impl = impls[name];
        return impl
          ? impl((inner ?? {}) as Record<string, unknown>)
          : { content: [{ type: "text" as const, text: JSON.stringify({ via: "call_tool", name }) }] };
      },
    );
  }
  if (opts.withSearch) {
    server.registerTool("search_tools", { inputSchema: { query: z.string() } }, async ({ query }) => {
      opts.calls?.push(`search_tools:${query}`);
      // The live shape (verified 2026-09-20): an ARRAY of full tool
      // definitions — inside the same `result` envelope as everything else,
      // which `toolNamesFromSearch` only ever sees unwrapped.
      const hits = (opts.searchHits ?? {})[query] ?? [];
      const defs = hits.map((name) => ({ name, title: name, description: `does ${name}`, inputSchema: { type: "object" }, annotations: {} }));
      return { content: [{ type: "text" as const, text: JSON.stringify({ result: defs }) }] };
    });
  }
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  return clientT;
}

/** Records every JSON-RPC method the client sends, so "how many times" is testable. */
function recordMethods(transport: Transport, into: string[]): Transport {
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    const method = (message as { method?: string }).method;
    if (method) into.push(method);
    return send(message, options);
  };
  return transport;
}

async function connect(opts: Parameters<typeof fakeServer>[0] = {}): Promise<ProviderMcp> {
  return connectProviderMcp({ url: "http://127.0.0.1:0/mcp", transport: await fakeServer(opts) });
}

/** Search resolution logs a line per op it cannot resolve; silence them. */
function silenceLogger(): void {
  vi.spyOn(serverLogger, "warn").mockImplementation(() => {});
  vi.spyOn(serverLogger, "info").mockImplementation(() => {});
}

afterEach(() => { vi.restoreAllMocks(); });

describe("connectProviderMcp", () => {
  it("calls a listed tool directly and parses the JSON out of its text block", async () => {
    const calls: string[] = [];
    const mcp = await connect({ calls });
    expect(await mcp.listToolNames()).toEqual(expect.arrayContaining(["accounts_list", "call_tool"]));
    expect(await mcp.call("accounts_list", {})).toEqual({ accounts: [{ _id: "a1" }] });
    expect(calls).toEqual(["accounts_list"]);
    await mcp.close();
  });

  it("reads the REAL fastmcp envelope: { result: \"<Python repr>\" }, end to end", async () => {
    // What every generated Zernio tool actually sends: the payload printed by
    // Python's own `str()`, wrapped in `result` (`x-fastmcp-wrap-result`). It
    // is not JSON — single quotes, `None`, `True` — and before the seam read
    // it, every answer normalized to a blank entity in total silence.
    const repr = `{'post': {'_id': 'p1', 'content': "it's live", 'scheduledFor': None, 'isDraft': True, 'tags': ['libi']}}`;
    const mcp = await connect({
      listed: ["posts_get_post"],
      impls: { posts_get_post: () => ({ content: [{ type: "text", text: JSON.stringify({ result: repr }) }] }) },
    });
    expect(await mcp.call("posts_get_post", { post_id: "p1" })).toEqual({
      post: { _id: "p1", content: "it's live", scheduledFor: null, isDraft: true, tags: ["libi"] },
    });
    await mcp.close();
  });

  it("an answer that is neither JSON nor a Python literal FAILS — it never becomes a blank entity", async () => {
    const mcp = await connect({
      listed: ["accounts_list"],
      impls: {
        accounts_list: () => ({
          content: [{ type: "text", text: JSON.stringify({ result: "Found 2 connected account(s): - instagram: @nagel" }) }],
        }),
      },
    });
    const err = await mcp.call("accounts_list", {}).catch((e: unknown) => e as SocialError);
    expect((err as SocialError).kind).toBe("provider");
    // The provider's own text is not echoed into the message: a payload
    // carries user content.
    expect((err as SocialError).message).not.toContain("@nagel");
    await mcp.close();
  });

  it("recognizes Zernio's own error text through call_tool and classifies it — never a generic parse failure", async () => {
    // Verified live 2026-09-20 on `ad_accounts_list_ad_accounts` for an
    // Instagram account with no linked Facebook: the wrapped payload is
    // exactly this — an ORDINARY (non-`isError`) result, because `call_tool`
    // relays the underlying tool's own failure as its own successful answer
    // text rather than raising. Before this was recognized, the text failed
    // to parse as JSON or a Python literal and fell through to the generic
    // "answered in a format libi cannot read" — a `provider`-kind error that
    // discarded the real message and turned an ordinary "no ads tree" account
    // into a hard failure for the whole Ads tab.
    const message = "Error: [422] A connected Facebook account is required to manage Instagram ads. (code: linked_account_required)";
    const mcp = await connect({
      listed: ["accounts_list"],
      impls: {
        ad_accounts_list_ad_accounts: () => ({ content: [{ type: "text", text: JSON.stringify({ result: message }) }] }),
      },
    });
    const err = await mcp.call("ad_accounts_list_ad_accounts", { account_id: "a1" }).catch((e: unknown) => e as SocialError);
    expect(err).toBeInstanceOf(SocialError);
    expect((err as SocialError).kind).toBe("validation");
    expect((err as SocialError).status).toBe(422);
    // Verbatim — the Ads tab depends on this reaching the UI exactly as the
    // provider wrote it.
    expect((err as SocialError).message).toBe(message);
    await mcp.close();
  });

  it("still fails an unrecognized prose answer as a generic parse failure, not every 'Error:'-less string", async () => {
    // A lossy convenience tool's own prose ("Found 2 connected account(s)…")
    // must not be swept into the same bucket — only text shaped like
    // Zernio's own `Error: [status] …` convention is a failure.
    const mcp = await connect({
      listed: ["accounts_list"],
      impls: {
        accounts_list: () => ({ content: [{ type: "text", text: JSON.stringify({ result: "Unknown tool: 'posts_retry_post'" }) }] }),
      },
    });
    const err = await mcp.call("accounts_list", {}).catch((e: unknown) => e as SocialError);
    expect((err as SocialError).kind).toBe("provider");
    await mcp.close();
  });

  it("routes an UNLISTED name through call_tool, passing the name and the arguments through", async () => {
    const calls: string[] = [];
    const seen: Record<string, unknown>[] = [];
    const mcp = await connect({
      calls,
      impls: {
        posts_create_post: (args) => {
          seen.push(args);
          return { content: [{ type: "text", text: JSON.stringify({ _id: "p1" }) }] };
        },
      },
    });
    expect(await mcp.call("posts_create_post", { content: "x" })).toEqual({ _id: "p1" });
    // The provider's generic dispatch carried it — the inner args arrived intact.
    expect(calls).toEqual(["call_tool:posts_create_post"]);
    expect(seen).toEqual([{ content: "x" }]);
    await mcp.close();
  });

  it("issues ONE tools/list for callers that race it — the memo is the in-flight promise", async () => {
    const methods: string[] = [];
    const mcp = await connectProviderMcp({
      url: "http://127.0.0.1:0/mcp",
      transport: recordMethods(await fakeServer(), methods),
    });
    // Nothing is awaited first: a value-memo would let each of these find the
    // cache empty and send its own `tools/list`.
    const [a, b] = await Promise.all([mcp.listToolNames(), mcp.listToolNames(), mcp.call("accounts_list", {})]);
    expect(a).toBe(b);
    expect(methods.filter((m) => m === "tools/list")).toHaveLength(1);
    await mcp.close();
  });

  it("maps a 429 tool error to rate_limited and carries the Retry-After moment", async () => {
    const mcp = await connect();
    const at = Date.now();
    await expect(mcp.call("boom", {})).rejects.toMatchObject({ kind: "rate_limited", status: 429 });
    const err = await mcp.call("boom", {}).then(() => null, (e: unknown) => e as SocialError);
    // 30 s from now, because the provider said 30 — never a number libi made up.
    const delta = Date.parse(err?.retryAt as string) - at;
    expect(delta).toBeGreaterThan(25_000);
    expect(delta).toBeLessThan(40_000);
    await mcp.close();
  });

  it("maps a 401 tool error to unauthorized so the UI can offer reconnect", async () => {
    const mcp = await connect({
      listed: ["accounts_list", "expired"],
      impls: { expired: () => ({ isError: true, content: [{ type: "text", text: "Error: 401 Unauthorized" }] }) },
    });
    await expect(mcp.call("expired", {})).rejects.toMatchObject({ kind: "unauthorized", status: 401 });
    await mcp.close();
  });

  it("keeps the grant out of the SocialError and out of every log line", async () => {
    const warn = vi.spyOn(serverLogger, "warn").mockImplementation(() => {});
    const debug = vi.spyOn(serverLogger, "debug").mockImplementation(() => {});
    const mcp = await connect({
      listed: ["accounts_list", "leaky"],
      impls: {
        leaky: () => ({
          isError: true,
          // Exactly the shape the SDK builds out of a response body.
          content: [{ type: "text", text: `Error POSTing to endpoint: {"status":500,"headers":{"authorization":"Bearer ${TOKEN}"},"access_token":"${TOKEN}"}` }],
        }),
      },
    });
    const err = await mcp.call("leaky", {}).then(() => null, (e: unknown) => e as SocialError);
    expect(err?.message).not.toContain("SUPERSECRETGRANT");
    expect(err?.message).toContain("[redacted]");
    const logged = JSON.stringify([...warn.mock.calls, ...debug.mock.calls]);
    expect(logged).not.toContain("SUPERSECRETGRANT");
    // The message is dropped entirely from logs — errors.ts → errShape.
    expect(logged).not.toContain("Error POSTing");
    await mcp.close();
  });
});

describe("timeoutForTool", () => {
  it("gives a presign and a post write room, and everything else the short ceiling", () => {
    expect(timeoutForTool("media_get_media_presigned_url")).toBe(SLOW_CALL_TIMEOUT_MS);
    expect(timeoutForTool("posts_create_post")).toBe(SLOW_CALL_TIMEOUT_MS);
    expect(timeoutForTool("posts_retry_post")).toBe(SLOW_CALL_TIMEOUT_MS);
    expect(timeoutForTool("accounts_list_accounts")).toBe(CALL_TIMEOUT_MS);
    expect(timeoutForTool("posts_list_posts")).toBe(CALL_TIMEOUT_MS);
    // Segments, not substrings: an "uploader" report is not an upload.
    expect(timeoutForTool("analytics_get_uploader_stats")).toBe(CALL_TIMEOUT_MS);
    expect(CALL_TIMEOUT_MS).toBeLessThan(SLOW_CALL_TIMEOUT_MS);
  });
});

describe("toSocialError", () => {
  it("turns the SDK's UnauthorizedError into the reconnect case without quoting it", () => {
    const e = toSocialError(new UnauthorizedError(`token ${TOKEN} rejected`));
    expect(e.kind).toBe("unauthorized");
    expect(e.status).toBe(401);
    expect(e.message).not.toContain("SUPERSECRETGRANT");
  });

  it("omits retryAt on a 429 with no Retry-After anywhere, rather than inventing a minute", () => {
    const e = toSocialError(new Error("HTTP 429 rate limited"));
    expect(e.kind).toBe("rate_limited");
    expect(e.retryAt).toBeUndefined();
  });

  it("does NOT read a status out of ordinary prose that happens to contain a number", () => {
    // Both of these were misread before the pattern required a status-ish prefix:
    // the first became a rate limit with a fabricated 60 s wait.
    const caption = toSocialError(new Error("caption exceeds the 429 character limit"));
    expect(caption.kind).toBe("provider");
    expect(caption.status).toBeUndefined();
    expect(caption.retryAt).toBeUndefined();

    const length = toSocialError(new Error("content must be under 500 characters"));
    expect(length.kind).toBe("provider");
    expect(length.status).toBeUndefined();
  });

  it("still reads a status the provider actually announced", () => {
    expect(toSocialError(new Error("HTTP 404 no such post")).kind).toBe("not_found");
    expect(toSocialError(new Error("Error: 409 duplicate")).kind).toBe("duplicate");
    expect(toSocialError(new Error('{"status": 422, "detail": "bad"}')).kind).toBe("validation");
  });

  it("prefers the transport's real status over anything in the text", () => {
    const e = toSocialError(new StreamableHTTPError(404, "HTTP 500 says the body"));
    expect(e.kind).toBe("not_found");
    expect(e.status).toBe(404);
  });

  it("passes a SocialError through untouched", () => {
    const original = toSocialError(new Error("HTTP 404 nope"));
    expect(toSocialError(original)).toBe(original);
  });
});

describe("observeRetryAfter", () => {
  it("reads the header off the 429 response itself and spends it once", async () => {
    const observer = observeRetryAfter(async () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }));
    await observer.fetch("http://127.0.0.1:0/mcp");
    const header = observer.take();
    expect(header).toBe("30");
    // Spent: the next failure must not inherit this one's window.
    expect(observer.take()).toBeNull();

    const e = toSocialError(new StreamableHTTPError(429, "Error POSTing to endpoint"), header);
    const delta = Date.parse(e.retryAt as string) - Date.now();
    expect(delta).toBeGreaterThan(25_000);
    expect(delta).toBeLessThan(40_000);
  });

  it("ignores a Retry-After on a response that was not a 429", async () => {
    const observer = observeRetryAfter(async () => new Response("ok", { status: 200, headers: { "retry-after": "99" } }));
    await observer.fetch("http://127.0.0.1:0/mcp");
    expect(observer.take()).toBeNull();
  });

  it("returns the response untouched to the caller", async () => {
    const observer = observeRetryAfter(async () => new Response("body", { status: 200 }));
    expect(await (await observer.fetch("http://127.0.0.1:0/mcp")).text()).toBe("body");
  });
});

describe("redactSecrets", () => {
  it("removes a bearer header, a bare JWT and an access_token field", () => {
    const out = redactSecrets(`Authorization: Bearer ${TOKEN} / ${TOKEN} / "access_token":"${TOKEN}"`);
    expect(out).not.toContain("SUPERSECRETGRANT");
  });

  it("removes a bare OAuth code and an unfamiliar token/secret key", () => {
    // The PKCE exchange's own request body, echoed back by a provider — both
    // credential-bearing SYNTAXES: `code=…` in a URL/query string, and
    // `"code":"…"` in JSON.
    expect(redactSecrets("code=SUPERSECRETGRANT&code_verifier=SUPERSECRETGRANT")).not.toContain("SUPERSECRETGRANT");
    expect(redactSecrets('{"code":"SUPERSECRETGRANT"}')).not.toContain("SUPERSECRETGRANT");
    // Key names libi has never seen, matched by shape rather than by list.
    expect(redactSecrets('{"session_token":"SUPERSECRETGRANT"}')).not.toContain("SUPERSECRETGRANT");
    expect(redactSecrets('{"signing_secret":"SUPERSECRETGRANT"}')).not.toContain("SUPERSECRETGRANT");
    expect(redactSecrets("token: SUPERSECRETGRANT")).not.toContain("SUPERSECRETGRANT");
  });

  it("leaves ordinary prose alone", () => {
    expect(redactSecrets("HTTP 429 Too Many Requests; Retry-After: 30")).toBe("HTTP 429 Too Many Requests; Retry-After: 30");
  });

  it("redacts an OAuth code by SYNTAX in both its credential-bearing forms", () => {
    // `code=…` in a URL/query string (the PKCE redirect and token exchange).
    expect(redactSecrets("https://libi.app/callback?state=abc&code=SUPERSECRETGRANT")).not.toContain("SUPERSECRETGRANT");
    // `"code":"…"` in a JSON body, with or without a space after the colon.
    expect(redactSecrets('{"grant_type":"authorization_code","code":"SUPERSECRETGRANT"}')).not.toContain("SUPERSECRETGRANT");
    expect(redactSecrets('{"code": "SUPERSECRETGRANT"}')).not.toContain("SUPERSECRETGRANT");
  });

  it("leaves a provider's prose reason code untouched — narrowed by syntax, not by value", () => {
    // Zernio's own ads-unavailable text (verified live, 2026-09-20): a bare,
    // unquoted `code:` with a colon-SPACE is prose, not a credential, and the
    // Ads tab depends on this reaching the UI verbatim to explain itself.
    const message = "Error: [422] A connected Facebook account is required to manage Instagram ads. (code: linked_account_required)";
    expect(redactSecrets(message)).toBe(message);
  });
});

describe("holdProviderMcp", () => {
  it("opens ONE client for concurrent callers and closes it on reset", async () => {
    let opened = 0;
    const closed: number[] = [];
    const holder = holdProviderMcp(async () => {
      const n = ++opened;
      const mcp = await connect();
      return { ...mcp, close: async () => { closed.push(n); await mcp.close(); } };
    });
    const [a, b] = await Promise.all([holder.get(), holder.get()]);
    expect(opened).toBe(1);
    expect(a).toBe(b);
    await holder.close();
    expect(closed).toEqual([1]);
    // A reset really dropped it: the next caller gets a fresh client.
    await holder.get();
    expect(opened).toBe(2);
    await holder.close();
  });

  it("does not cache a failed connect", async () => {
    let attempts = 0;
    const holder = holdProviderMcp(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("HTTP 503 upstream");
      return connect();
    });
    await expect(holder.get()).rejects.toThrow();
    await expect(holder.get()).resolves.toBeDefined();
    expect(attempts).toBe(2);
    await holder.close();
  });

  it("makes a disconnect TERMINAL: no reopen, and not a retryable failure", async () => {
    let opened = 0;
    const holder = holdProviderMcp(async () => { opened += 1; return connect(); });
    await holder.get();
    await holder.disconnect();
    const err = await holder.get().then(() => null, (e: unknown) => e as SocialError);
    expect(err?.kind).toBe("unauthorized");
    expect(isRetryable(err as SocialError, { kind: "read" })).toBe(false);
    // The grant is gone; nothing reopened it behind the caller's back.
    expect(opened).toBe(1);
  });

  it("does not report a connect that lost its race with disconnect as a provider blip", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = holdProviderMcp(async () => {
      await gate;
      throw new Error("HTTP 503 socket torn down");
    });
    const pending = holder.get();
    const closing = holder.disconnect();
    release?.();
    const err = await pending.then(() => null, (e: unknown) => e as SocialError);
    // Without the `closed` guard this is `provider` — retryable — and a caller
    // would spin against a connection the user deliberately ended.
    expect(err?.kind).toBe("unauthorized");
    expect(isRetryable(err as SocialError, { kind: "read" })).toBe(false);
    await closing;
  });
});

/**
 * A `ProviderMcp` that lies the way the LIVE Zernio server does: `tools/list`
 * advertises only the curated tools, while `call_tool` reaches the full-shaped
 * long tail, and a name it does not know comes back `Unknown tool: '…'`.
 *
 * This is the whole reason the resolver's defect survived two tasks of green
 * tests — the old double answered whatever it was asked, so a resolver that
 * preferred the LISTED name looked identical to one that dispatched the right
 * one. Every test below fails against that resolver.
 */
function liveLikeMcp(
  opts: { listed?: string[]; reachable?: string[]; searchHits?: Record<string, string[]>; searchThrows?: boolean } = {},
): { mcp: ProviderMcp; calls: Array<{ name: string; via: "direct" | "call_tool"; args: Record<string, unknown> }> } {
  const listed = opts.listed ?? CURATED_TOOLS;
  const reachable = opts.reachable ?? REACHABLE_TOOLS;
  const calls: Array<{ name: string; via: "direct" | "call_tool"; args: Record<string, unknown> }> = [];
  const mcp: ProviderMcp = {
    async listToolNames() {
      return listed;
    },
    async call<X>(name: string, args: Record<string, unknown>) {
      // The production client's own rule (mcp-client.ts#call): a listed name
      // goes direct, anything else takes the `call_tool` hop.
      calls.push({ name, via: listed.includes(name) ? "direct" : "call_tool", args });
      if (name === SEARCH_TOOLS) {
        if (opts.searchThrows) throw toSocialError(new Error("HTTP 500 search is down"));
        const hits = (opts.searchHits ?? {})[String(args.query)] ?? [];
        return hits.map((n) => ({ name: n, title: n, description: `does ${n}`, inputSchema: {}, annotations: {} })) as X;
      }
      if (!reachable.includes(name)) throw toSocialError(new Error(unknownToolText(name)));
      return { calledTool: name } as X;
    },
    async close() {},
  };
  return { mcp, calls };
}

/** The exact tool every op must dispatch to — the first candidate, always. */
const EXPECTED_TOOL: Record<ZernioOp, string> = {
  "accounts.list": "accounts_list_accounts",
  "accounts.health": "accounts_get_account_health",
  "accounts.tiktokCreatorInfo": "accounts_get_tik_tok_creator_info",
  "posts.list": "posts_list_posts",
  "posts.get": "posts_get_post",
  "posts.create": "posts_create_post",
  "posts.update": "posts_update_post",
  "posts.delete": "posts_delete_post",
  // The one op with no full-shaped tool: `call_tool` answered
  // `Unknown tool: 'posts_retry_post'` live, so the curated name leads.
  "posts.retry": "posts_retry",
  "analytics.post": "analytics_get_analytics",
  "analytics.instagramStory": "instagram_get_instagram_story_insights",
  "media.presign": "media_get_media_presigned_url",
  "validate.post": "validate_post",
  "validate.media": "validate_media",
  "ads.accounts": "ad_accounts_list_ad_accounts",
  "ads.campaigns": "ad_campaigns_list_ad_campaigns",
  "ads.list": "ad_campaigns_list_ads",
};

describe("resolveOps — tools/list never decides WHICH tool an op maps to", () => {
  it("chooses the full-shaped tool even though the server lists only the curated one", () => {
    // This is the live list. `accounts_list`, `posts_create`, `posts_get`,
    // `posts_list` are on it; `accounts_list_accounts`, `posts_create_post`,
    // `posts_get_post`, `posts_list_posts` are NOT. Preferring what is listed
    // is what picked the prose tool and failed with "answered in a format libi
    // cannot read".
    const { resolved } = resolveOps(CURATED_TOOLS);
    for (const op of ZERNIO_OP_IDS) expect(resolved[op]).toBe(EXPECTED_TOOL[op]);
  });

  it("chooses the same names when the server lists nothing at all but call_tool", () => {
    const { resolved, missing } = resolveOps(["call_tool"]);
    for (const op of ZERNIO_OP_IDS) expect(resolved[op]).toBe(EXPECTED_TOOL[op]);
    // `call_tool` reaches every one of them, so nothing is missing.
    expect(missing).toEqual([]);
  });

  it("reports an op as missing only when there is no way to dispatch at all", () => {
    const { missing } = resolveOps(["accounts_list"]);
    expect(missing).toContain("posts.create");
    // …including the ops whose curated name IS listed: `accounts_list` is a
    // denied prose tool, not a fallback.
    expect(missing).toContain("accounts.list");
  });

  it("never names a denied prose tool as a candidate, and denies every curated shadow", () => {
    for (const op of ZERNIO_OP_IDS) {
      for (const c of ZERNIO_OPS[op].candidates) expect(ZERNIO_LOSSY_TOOLS).not.toContain(c);
    }
    // Each denied name is one the live server LISTS, shadowing a full-shaped
    // tool that exists. That is precisely why the deny list has to exist.
    for (const denied of ZERNIO_LOSSY_TOOLS) expect(CURATED_TOOLS).toContain(denied);
  });

  it("names only real Zernio tools as the ads candidates", () => {
    // `ads_list_ad_accounts` never existed; ad accounts live under `ad_accounts_*`.
    expect(ZERNIO_OPS["ads.accounts"].candidates).toEqual(["ad_accounts_list_ad_accounts"]);
    // And they are per connected account, so a caller must send one.
    expect(ZERNIO_OPS["ads.accounts"].requiredArgs).toEqual(["account_id"]);
  });

  it("every candidate that exists live is reachable, and none is a guess at a name that is not", () => {
    for (const op of ZERNIO_OP_IDS) {
      expect(REACHABLE_TOOLS).toContain(ZERNIO_OPS[op].candidates[0]);
    }
  });
});

describe("resolveOpsFromServer", () => {
  it("costs ONE tools/list and never searches — search ranking decides nothing", async () => {
    const { mcp, calls } = liveLikeMcp();
    const res = await resolveOpsFromServer(mcp);
    expect(res.resolved["accounts.list"]).toBe("accounts_list_accounts");
    // Live, `search_tools` answered "list accounts" with six `ad_accounts_*`
    // tools and never mentioned `accounts_list_accounts`. A pre-flight that
    // believed that answer would mark a working op unsupported.
    expect(calls).toEqual([]);
    await mcp.close();
  });
});

describe("callOp — dispatch by exact name", () => {
  it("sends every op to its exact full-shaped tool, through call_tool when unlisted", async () => {
    const { mcp, calls } = liveLikeMcp();
    const res = await resolveOpsFromServer(mcp);
    for (const op of ZERNIO_OP_IDS) await callOp(mcp, res, op, {});
    expect(calls.map((c) => c.name)).toEqual(ZERNIO_OP_IDS.map((op) => EXPECTED_TOOL[op]));
    for (const c of calls) {
      expect(c.via).toBe(CURATED_TOOLS.includes(c.name) ? "direct" : "call_tool");
    }
    // The unlisted ones are the point: they are reachable ONLY this way, and
    // the count is asserted so a tool quietly moving into the listed set (or a
    // new op forgetting `call_tool`) fails here rather than at runtime.
    expect(calls.filter((c) => c.via === "call_tool").length).toBe(12);
    await mcp.close();
  });

  it("still reaches every op when the server lists nothing but the prose tools", async () => {
    // A leaner curated set than today's — a shape Zernio could ship tomorrow.
    // Nothing about dispatch may depend on what is listed.
    const listed = ["accounts_list", "posts_create", "posts_get", "posts_list", "call_tool", "search_tools"];
    const { mcp, calls } = liveLikeMcp({ listed });
    const res = await resolveOpsFromServer(mcp);
    for (const op of ZERNIO_OP_IDS) await callOp(mcp, res, op, {});
    expect(calls.map((c) => c.name)).toEqual(ZERNIO_OP_IDS.map((op) => EXPECTED_TOOL[op]));
    expect(calls.every((c) => c.via === "call_tool")).toBe(true);
    await mcp.close();
  });

  it("never calls a denied prose tool for accounts.list, whatever is listed", async () => {
    const { mcp, calls } = liveLikeMcp();
    const res = await resolveOpsFromServer(mcp);
    await callOp(mcp, res, "accounts.list", {});
    expect(calls.map((c) => c.name)).toEqual(["accounts_list_accounts"]);
    expect(calls.some((c) => ZERNIO_LOSSY_TOOLS.includes(c.name))).toBe(false);
    await mcp.close();
  });
});

describe("rename recovery — conservative, or loud", () => {
  /** The op's tool has been renamed away: everything else is still reachable. */
  const withoutTool = (tool: string) => REACHABLE_TOOLS.filter((t) => t !== tool);

  it("adopts a genuine rename and remembers it", async () => {
    silenceLogger();
    const { mcp, calls } = liveLikeMcp({
      reachable: [...withoutTool("posts_create_post"), "posts_create_social_post"],
      // The convenience `posts_create` is still there and must not win — nor
      // may the LONGEST name, which the old length tie-break would have picked.
      searchHits: { "create post": ["posts_create", "posts_quick_create_now_v2", "posts_create_social_post"] },
    });
    const res = await resolveOpsFromServer(mcp);
    await callOp(mcp, res, "posts.create", {});
    expect(calls.map((c) => c.name)).toEqual(["posts_create_post", SEARCH_TOOLS, "posts_create_social_post"]);
    expect(res.resolved["posts.create"]).toBe("posts_create_social_post");
    expect(res.discovered["posts.create"]).toBe("posts_create_social_post");
    // Remembered: the second call goes straight there, no second search.
    await callOp(mcp, res, "posts.create", {});
    expect(calls.filter((c) => c.name === SEARCH_TOOLS).length).toBe(1);
    await mcp.close();
  });

  it("a CREATE op can never be answered by a get or a list tool", async () => {
    silenceLogger();
    // Live, `search_tools` ranked `posts_update_post` above `posts_create_post`
    // for "create post", and the resolver adopted `posts_get_post` for
    // `posts.create` — a READ tool for a WRITE op. Both are hard failures now.
    for (const hits of [["posts_get_post"], ["posts_list_posts"], ["posts_update_post"], ["posts_delete_post"]]) {
      const { mcp, calls } = liveLikeMcp({
        reachable: withoutTool("posts_create_post"),
        searchHits: { "create post": hits },
      });
      const res = await resolveOpsFromServer(mcp);
      const err = await callOp(mcp, res, "posts.create", {}).catch((e: unknown) => e as SocialError);
      expect(err).toBeInstanceOf(SocialError);
      expect((err as SocialError).kind).toBe("unsupported");
      expect(isRetryable(err as SocialError, { kind: "read" })).toBe(false);
      expect((err as SocialError).message).toContain("posts.create");
      // Nothing was substituted: the failed name and the search, and no more.
      expect(calls.map((c) => c.name)).toEqual(["posts_create_post", SEARCH_TOOLS]);
      await mcp.close();
    }
  });

  it("a READ op can never be answered by a create, update or delete tool", async () => {
    silenceLogger();
    const { mcp, calls } = liveLikeMcp({
      reachable: withoutTool("posts_get_post"),
      searchHits: { "get post": ["posts_create_post", "posts_delete_post", "posts_update_post"] },
    });
    const res = await resolveOpsFromServer(mcp);
    const err = await callOp(mcp, res, "posts.get", {}).catch((e: unknown) => e as SocialError);
    expect((err as SocialError).kind).toBe("unsupported");
    expect(calls.map((c) => c.name)).toEqual(["posts_get_post", SEARCH_TOOLS]);
    await mcp.close();
  });

  it("does not answer 'list accounts' with the AD accounts tool", async () => {
    silenceLogger();
    // This is the live search result, verbatim in shape: six `ad_accounts_*`
    // hits and no `accounts_list_accounts`. Substring matching picked the
    // longest of them.
    const { mcp, calls } = liveLikeMcp({
      reachable: withoutTool("accounts_list_accounts"),
      searchHits: {
        "list accounts": [
          "tracking_tags_list_tracking_tag_shared_accounts",
          "ad_accounts_list_ad_accounts",
          "ad_accounts_list_ads_instagram_accounts",
          "ad_accounts_list_account_callouts",
        ],
      },
    });
    const res = await resolveOpsFromServer(mcp);
    const err = await callOp(mcp, res, "accounts.list", {}).catch((e: unknown) => e as SocialError);
    expect((err as SocialError).kind).toBe("unsupported");
    expect(calls.map((c) => c.name)).toEqual(["accounts_list_accounts", SEARCH_TOOLS]);
    await mcp.close();
  });

  it("does not answer 'list ad campaigns' with the ad SETS tool", async () => {
    silenceLogger();
    // Live, `ads.campaigns` resolved to `ad_campaigns_list_ad_sets` — the
    // right prefix and the right action, but a different resource. The
    // segment-score rule is what refuses it: it matches "list" and nothing
    // else, while `ad_campaigns_list_ad_campaigns` matches "list" + "campaigns".
    const { mcp } = liveLikeMcp({
      reachable: withoutTool("ad_campaigns_list_ad_campaigns"),
      searchHits: { "list ad campaigns": ["ad_campaigns_list_ad_sets", "ad_campaigns_list_ad_campaigns_v2"] },
    });
    expect(await recoverOp(mcp, "ads.campaigns", "ad_campaigns_list_ad_campaigns")).toBe("ad_campaigns_list_ad_campaigns_v2");
    // With only the ad-sets tool on offer there is no same-operation hit at
    // all, so the op fails rather than reading the wrong resource.
    const only = liveLikeMcp({
      reachable: withoutTool("ad_campaigns_list_ad_campaigns"),
      searchHits: { "list ad campaigns": ["ad_campaigns_list_ad_sets"] },
    });
    const res2 = await resolveOpsFromServer(only.mcp);
    const err = await callOp(only.mcp, res2, "ads.campaigns", {}).catch((e: unknown) => e as SocialError);
    expect((err as SocialError).kind).toBe("unsupported");
    expect(only.calls.map((c) => c.name)).toEqual(["ad_campaigns_list_ad_campaigns", SEARCH_TOOLS]);
    await mcp.close();
    await only.mcp.close();
  });

  it("never adopts a denied prose tool, even when it is the only hit", async () => {
    silenceLogger();
    const { mcp } = liveLikeMcp({
      reachable: withoutTool("posts_create_post"),
      searchHits: { "create post": ["posts_create"] },
    });
    const res = await resolveOpsFromServer(mcp);
    const err = await callOp(mcp, res, "posts.create", {}).catch((e: unknown) => e as SocialError);
    // The deny list is the ONLY thing standing between this search result and
    // a silently single-platform, prose-flattened create.
    expect((err as SocialError).kind).toBe("unsupported");
    expect(res.resolved["posts.create"]).toBe("posts_create_post");
    await mcp.close();
  });

  it("falls back to the op's own remaining candidate when search knows nothing", async () => {
    silenceLogger();
    // `posts_retry` is the live name; `posts_retry_post` is kept behind it in
    // case Zernio generates the full shape later. A candidate libi declared
    // for this op is not a substitution, so it may be tried unconfirmed.
    const { mcp, calls } = liveLikeMcp({
      reachable: [...REACHABLE_TOOLS.filter((t) => t !== "posts_retry"), "posts_retry_post"],
      searchHits: {},
    });
    const res = await resolveOpsFromServer(mcp);
    await callOp(mcp, res, "posts.retry", { post_id: "p1" });
    expect(calls.map((c) => c.name)).toEqual(["posts_retry", SEARCH_TOOLS, "posts_retry_post"]);
    await mcp.close();
  });

  it("fails loudly when search itself is down and the op has no other candidate", async () => {
    silenceLogger();
    const { mcp, calls } = liveLikeMcp({ reachable: withoutTool("posts_create_post"), searchThrows: true });
    const res = await resolveOpsFromServer(mcp);
    const err = await callOp(mcp, res, "posts.create", {}).catch((e: unknown) => e as SocialError);
    expect((err as SocialError).kind).toBe("unsupported");
    expect(calls.map((c) => c.name)).toEqual(["posts_create_post", SEARCH_TOOLS]);
    await mcp.close();
  });

  it("does not recover a failure that is not an unknown tool — a 429 stays a 429", async () => {
    silenceLogger();
    const calls: string[] = [];
    const mcp: ProviderMcp = {
      async listToolNames() {
        return CURATED_TOOLS;
      },
      async call<X>(name: string) {
        calls.push(name);
        throw toSocialError(new Error("HTTP 429 Too Many Requests"));
        return null as X;
      },
      async close() {},
    };
    const res = await resolveOpsFromServer(mcp);
    const err = await callOp(mcp, res, "posts.create", {}).catch((e: unknown) => e as SocialError);
    expect((err as SocialError).kind).toBe("rate_limited");
    // No search, no retry: a rate limit is not a rename.
    expect(calls).toEqual(["posts_create_post"]);
  });
});

describe("actionMatches", () => {
  it("refuses a tool whose verb belongs to a different action", () => {
    expect(actionMatches("create", "posts_create_post")).toBe(true);
    expect(actionMatches("create", "posts_get_post")).toBe(false);
    expect(actionMatches("create", "posts_list_posts")).toBe(false);
    expect(actionMatches("read", "posts_delete_post")).toBe(false);
    expect(actionMatches("read", "posts_create_post")).toBe(false);
    expect(actionMatches("update", "posts_update_post")).toBe(true);
    expect(actionMatches("delete", "posts_delete_post")).toBe(true);
    expect(actionMatches("retry", "posts_retry")).toBe(true);
  });

  it("refuses a name carrying two actions, or none it recognises", () => {
    // A "get or create" tool is not a create tool; an unrecognisable name is
    // not evidence of anything, and adopting one is the substitution the bar
    // exists to refuse.
    expect(actionMatches("create", "posts_get_or_create_post")).toBe(false);
    expect(actionMatches("read", "posts_whatever_post")).toBe(false);
  });

  it("classifies by the verb in the NAME, not by REST semantics", () => {
    // Zernio spells the presign as a GET, so `media.presign` is a read op.
    expect(ZERNIO_OPS["media.presign"].action).toBe("read");
    expect(actionMatches("read", "media_get_media_presigned_url")).toBe(true);
  });
});

describe("isUnknownToolError", () => {
  it("recognises Zernio's own words, and only for the name that failed", () => {
    const err = toSocialError(new Error(unknownToolText("posts_create_post")));
    expect(isUnknownToolError(err, "posts_create_post")).toBe(true);
    expect(isUnknownToolError(err, "posts_get_post")).toBe(false);
    expect(isUnknownToolError(toSocialError(new Error("HTTP 500 boom")), "posts_create_post")).toBe(false);
    expect(isUnknownToolError(new Error(unknownToolText("posts_create_post")), "posts_create_post")).toBe(false);
  });
});

describe("toolNamesFromSearch", () => {
  it("reads the array of tool definitions search_tools actually answers", () => {
    expect(toolNamesFromSearch([
      { name: "posts_create_post", title: "Create post", description: "…", inputSchema: { type: "object" }, annotations: {} },
      { name: "posts_update_post", title: "Update post", description: "…", inputSchema: { type: "object" } },
    ])).toEqual(["posts_create_post", "posts_update_post"]);
    expect(toolNamesFromSearch(["posts_get_post", "posts_get_post"])).toEqual(["posts_get_post"]);
  });

  it("yields nothing for a shape it does not recognise, rather than guessing a name out of prose", () => {
    // A shape this does not recognise yields nothing. Mining it for
    // snake_case words is how a plausible but wrong name gets chosen.
    expect(toolNamesFromSearch({ text: "try posts_list_posts or posts_list" })).toEqual([]);
    expect(toolNamesFromSearch({ tools: [{ name: "posts_create_post" }] })).toEqual([]);
    expect(toolNamesFromSearch(null)).toEqual([]);
  });
});

describe("toolForOp", () => {
  it("names the op, the candidates and the search when nothing implements it", () => {
    const res = resolveOps(["accounts_list"]);
    expect(() => toolForOp(res, "posts.create")).toThrow(/posts\.create/);
    try {
      toolForOp(res, "posts.create");
    } catch (e) {
      const err = e as SocialError;
      // NOT `provider`: that kind is retryable and would have this structural
      // failure resending forever as if it were a transient upstream blip.
      expect(err.kind).toBe("unsupported");
      expect(isRetryable(err, { kind: "read" })).toBe(false);
      expect(err.message).toContain("posts_create_post");
      expect(err.message).toContain("create post");
      expect(err.message).toContain("search_tools");
    }
  });

  it("refuses to hand back a lossy tool even if one were resolved", () => {
    const res = resolveOps(["call_tool"]);
    res.resolved["posts.create"] = "posts_create";
    expect(() => toolForOp(res, "posts.create")).toThrow(/posts\.create/);
    res.resolved["accounts.list"] = "accounts_list";
    expect(() => toolForOp(res, "accounts.list")).toThrow(/accounts\.list/);
  });

  it("returns the resolved name for a reachable op", () => {
    expect(toolForOp(resolveOps(["call_tool"]), "accounts.list")).toBe("accounts_list_accounts");
  });
});

/**
 * The defect this suite exists for: a user's Zernio token carries no `ads`
 * resource group, an ads read answered `403 insufficient_permissions`, and
 * libi deleted their entire sign-in from disk over it. Three things had to be
 * true at once, and each is pinned below — the 403 never reaches the SDK's
 * auth machinery, it never classifies as `unauthorized`, and it reads as one
 * feature being unavailable.
 */
describe("a scoped 403 is not a dead token", () => {
  const SCOPE_CHALLENGE = 'Bearer error="insufficient_scope", scope="ads:read"';

  it("toSocialError classifies a 403 as forbidden, NOT unauthorized", () => {
    const e = toSocialError(new StreamableHTTPError(403, "Error POSTing to endpoint: insufficient_permissions"));
    expect(e.kind).toBe("forbidden");
    expect(e.status).toBe(403);
  });

  it("a 401 is still unauthorized — the two must not be merged in either direction", () => {
    expect(toSocialError(new StreamableHTTPError(401, "Error POSTing to endpoint: token expired")).kind).toBe("unauthorized");
  });

  it("Zernio's own 403 tool text classifies as forbidden and keeps the provider's words", () => {
    const e = toSocialError(new Error("Error: [403] Your token does not include the ads resource group. (code: insufficient_permissions)"));
    expect(e.kind).toBe("forbidden");
    expect(e.status).toBe(403);
    expect(e.message).toContain("insufficient_permissions");
  });

  it("a forbidden error is never auto-retried — the same token is forbidden every time", () => {
    expect(isRetryable(new SocialError("forbidden", "no ads scope", { status: 403 }), { kind: "read" })).toBe(false);
  });

  it("stripScopeChallenge drops the challenge on a 403, keeping the status and the body", async () => {
    const wrapped = stripScopeChallenge(async () =>
      new Response(JSON.stringify({ error: "insufficient_permissions" }), {
        status: 403,
        headers: { "content-type": "application/json", "www-authenticate": SCOPE_CHALLENGE },
      }),
    );
    const res = await wrapped("https://mcp.example/mcp", {});
    expect(res.status).toBe(403);
    // The header is the ONLY thing removed: the SDK reads the body to build
    // its error text, and the provider's explanation has to survive.
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/json");
    await expect(res.json()).resolves.toEqual({ error: "insufficient_permissions" });
  });

  it("leaves a 401 challenge alone — refreshing a rejected token there is correct", async () => {
    const wrapped = stripScopeChallenge(async () =>
      new Response("nope", { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"' } }),
    );
    const res = await wrapped("https://mcp.example/mcp", {});
    expect(res.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
  });

  it("leaves an ordinary 200 untouched", async () => {
    const body = JSON.stringify({ ok: true });
    const wrapped = stripScopeChallenge(async () => new Response(body, { status: 200 }));
    await expect((await wrapped("https://mcp.example/mcp", {})).json()).resolves.toEqual({ ok: true });
  });

  /**
   * End to end over the real `StreamableHTTPClientTransport` and the real
   * `auth()`, because the behaviour that matters is the SDK's, not ours.
   *
   * The fake below answers a token refresh with `invalid_grant`, which is what
   * a provider says when libi asks to widen a grant the user approved
   * narrowly. WITHOUT the seam this exact fixture was measured making the SDK
   * walk: 403 → discovery → `POST /token` → `InvalidGrantError` →
   * `invalidateCredentials("tokens")` — and that last call is `store.clear()`,
   * the user's whole sign-in off disk. The assertion is that it never happens.
   */
  it("a 403 from the live transport never invalidates the grant, and surfaces as forbidden", async () => {
    const invalidated: string[] = [];
    const tokenPosts: string[] = [];
    const authProvider = {
      get redirectUrl() { return "http://127.0.0.1:3000/cb"; },
      get clientMetadata() { return { client_name: "libi", redirect_uris: ["http://127.0.0.1:3000/cb"] }; },
      clientInformation: () => ({ client_id: "cid" }),
      saveClientInformation: () => {},
      tokens: () => ({ access_token: "at", refresh_token: "rt", token_type: "bearer" }),
      saveTokens: () => {},
      redirectToAuthorization: () => {},
      saveCodeVerifier: () => {},
      codeVerifier: () => "cv",
      invalidateCredentials: (scope: string) => { invalidated.push(scope); },
    };

    const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      let msg: { id?: number; method?: string; params?: { protocolVersion?: string } } = {};
      // A non-JSON body is the form-encoded token request — the step that
      // destroys the grant, so it is recorded rather than merely answered.
      try { msg = JSON.parse(String(init.body)) as typeof msg; } catch { /* token endpoint */ }
      if (!msg.method) {
        tokenPosts.push(String(url));
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
      }
      const json = (result: unknown) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "sess-1" },
        });
      if (msg.method === "initialize") {
        return json({ protocolVersion: msg.params?.protocolVersion, capabilities: {}, serverInfo: { name: "fake-zernio", version: "1" } });
      }
      if (msg.method.startsWith("notifications/")) return new Response(null, { status: 202 });
      if (msg.method === "tools/list") return json({ tools: [] });
      // The ads read: the resource group the user's grant never carried.
      return new Response(JSON.stringify({ error: "insufficient_permissions", detail: "token lacks the ads resource group" }), {
        status: 403,
        headers: { "content-type": "application/json", "www-authenticate": SCOPE_CHALLENGE },
      });
    };

    const mcp = await connectProviderMcp({
      url: "https://mcp.example/mcp",
      authProvider: authProvider as unknown as Parameters<typeof connectProviderMcp>[0]["authProvider"],
      fetch: fetchImpl as unknown as Parameters<typeof connectProviderMcp>[0]["fetch"],
    });

    await expect(mcp.call("ad_accounts_list_ad_accounts", { account_id: "ig_1" })).rejects.toMatchObject({
      kind: "forbidden",
      status: 403,
    });
    // THE assertion: `invalidateCredentials("tokens")` is `store.clear()`.
    expect(invalidated).toEqual([]);
    // And the grant was never even presented for widening — the upscope that
    // provokes the rejection does not happen at all.
    expect(tokenPosts).toEqual([]);
    await mcp.close();
  });

});

/**
 * The other half of the same seam, and the reason it can be drawn safely: a
 * genuine token rejection must STILL clear the grant, and must still be
 * reported. These run the real `LibiOAuthClientProvider` over a real
 * `SocialTokenStore` on a temp home, so the write to disk is the real one.
 */
describe("a genuinely rejected token still clears the grant — and says so", () => {
  const GRANT: StoredGrant = {
    tokens: { access_token: "at-secret", refresh_token: "rt-secret" },
    client: { client_id: "cid", redirect_uris: ["http://127.0.0.1:3000/api/social/oauth/callback"] },
    connectedAt: "2026-09-20T00:00:00.000Z",
    scopes: ["posts:read"],
  };

  /**
   * `status` is what the provider's MCP endpoint answers the tool call with.
   * The token endpoint always rejects the refresh, as a revoked grant's would,
   * and registration succeeds — which is what a real provider does, and what
   * makes the SDK get as far as wanting a browser sign-in it cannot run in the
   * background.
   */
  function fetchFor(status: 401 | 403, challenge: string) {
    return async (url: string | URL, init?: RequestInit): Promise<Response> => {
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      if (String(url).endsWith("/register")) {
        return new Response(JSON.stringify({ client_id: "cid-new", redirect_uris: ["http://127.0.0.1:3000/api/social/oauth/callback"] }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      let msg: { id?: number; method?: string; params?: { protocolVersion?: string } } = {};
      try { msg = JSON.parse(String(init.body)) as typeof msg; } catch { /* token endpoint */ }
      if (!msg.method) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
      }
      const json = (result: unknown) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "sess-1" },
        });
      if (msg.method === "initialize") {
        return json({ protocolVersion: msg.params?.protocolVersion, capabilities: {}, serverInfo: { name: "fake-zernio", version: "1" } });
      }
      if (msg.method.startsWith("notifications/")) return new Response(null, { status: 202 });
      if (msg.method === "tools/list") return json({ tools: [] });
      return new Response(JSON.stringify({ error: "rejected" }), {
        status,
        headers: { "content-type": "application/json", "www-authenticate": challenge },
      });
    };
  }

  async function run(status: 401 | 403, challenge: string) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-social-403-"));
    const store = new SocialTokenStore("zernio", home);
    store.write(GRANT);
    const provider = new LibiOAuthClientProvider({
      providerId: "zernio",
      store,
      redirectUrl: "http://127.0.0.1:3000/api/social/oauth/callback",
      scopes: ["posts:read"],
      onRedirect: () => {},
      interactive: false,
    });
    const mcp = await connectProviderMcp({
      url: "https://mcp.example/mcp",
      authProvider: provider,
      fetch: fetchFor(status, challenge) as unknown as Parameters<typeof connectProviderMcp>[0]["fetch"],
    });
    const err = await mcp.call("ad_accounts_list_ad_accounts", { account_id: "ig_1" }).catch((e: unknown) => e as SocialError);
    await mcp.close();
    const after = store.status();
    fs.rmSync(home, { recursive: true, force: true });
    return { err: err as SocialError, after };
  }

  it("a 401 whose refresh is rejected clears the grant AND reports needsReconnect", async () => {
    const { err, after } = await run(401, 'Bearer error="invalid_token"');
    expect(err.kind).toBe("unauthorized");
    expect(after.connected).toBe(false);
    // Not "never connected" — this is what the Social page turns into
    // "libi's connection was revoked. Your agent's connection is unaffected."
    expect(after.revoked).toBe(true);
  });

  it("the SAME grant survives a 403 untouched — the two paths differ only in the status code", async () => {
    const { err, after } = await run(403, 'Bearer error="insufficient_scope", scope="ads:read"');
    expect(err.kind).toBe("forbidden");
    expect(after.connected).toBe(true);
    expect(after.revoked).toBe(false);
  });
});

/**
 * The defect measured live on 2026-09-21: libi's own grant expired one hour
 * after `connectedAt`, every social route said "libi's connection was revoked",
 * and the grant file was BYTE-IDENTICAL throughout — nothing ever tried to
 * refresh. Restarting the server fixed it on the first attempt.
 *
 * The cause is the SHAPE of the provider's 401. Establishing a session is
 * gated at the HTTP layer (a real 401 the SDK's transport refreshes on, which
 * is what the restart used), but a tool call on an established session answers
 * **HTTP 200** with `Error: [401] Unauthorized` as its result TEXT. Nothing in
 * the SDK sees a 401 at all, so `auth()` never runs.
 *
 * These run the real `StreamableHTTPClientTransport`, the real `auth()`, the
 * real `LibiOAuthClientProvider` and a real `SocialTokenStore` on a temp home,
 * so the refresh, the retry and the write to disk are all the real ones. Only
 * `fetch` is the fake.
 */
describe("a text-shaped 401 refreshes the grant and retries — the live expiry defect", () => {
  const STALE = "stale-access-token";
  const FRESH = "fresh-access-token";

  interface Seen {
    /** Authorization header on each `tools/call`, in order. */
    bearers: string[];
    /** One entry per token-endpoint POST — the refreshes that actually happened. */
    tokenPosts: number;
  }

  /**
   * `answer` decides a `tools/call`'s reply from the BEARER it arrived with —
   * which is how the real thing behaves, and the only way a fixture can tell a
   * retry that should now succeed from one that should not. What it returns is
   * the TEXT of an ordinary, non-`isError`, HTTP-200 tool result: this
   * provider's way of reporting an upstream failure.
   */
  function fetchFor(opts: {
    answer: (bearer: string) => string;
    /** `null` rejects the refresh with `invalid_grant`, as a dead grant's would. */
    refreshed: string | null;
    seen: Seen;
    tokenDelayMs?: number;
  }) {
    return async (url: string | URL, init?: RequestInit): Promise<Response> => {
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      if (String(url).endsWith("/register")) {
        return new Response(JSON.stringify({ client_id: "cid", redirect_uris: ["http://127.0.0.1:3000/api/social/oauth/callback"] }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      let msg: { id?: number; method?: string; params?: { protocolVersion?: string } } = {};
      // A body that is not JSON-RPC is the form-encoded token request.
      try { msg = JSON.parse(String(init.body)) as typeof msg; } catch { /* token endpoint */ }
      if (!msg.method) {
        opts.seen.tokenPosts += 1;
        // Slower than a tool call on purpose: it is what makes the
        // single-flight assertion deterministic rather than a race.
        await new Promise((r) => setTimeout(r, opts.tokenDelayMs ?? 5));
        if (!opts.refreshed) {
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
        }
        return new Response(
          JSON.stringify({ access_token: opts.refreshed, token_type: "bearer", expires_in: 3600, refresh_token: "rt-rotated" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const json = (result: unknown) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "sess-1" },
        });
      if (msg.method === "initialize") {
        return json({ protocolVersion: msg.params?.protocolVersion, capabilities: {}, serverInfo: { name: "fake-zernio", version: "1" } });
      }
      if (msg.method.startsWith("notifications/")) return new Response(null, { status: 202 });
      if (msg.method === "tools/list") {
        return json({ tools: [{ name: "accounts_get_account_health", inputSchema: { type: "object" } }] });
      }
      const bearer = new Headers(init.headers).get("authorization") ?? "";
      opts.seen.bearers.push(bearer);
      // HTTP 200, `isError` unset: the provider's own failure, relayed as text.
      return json({ content: [{ type: "text", text: opts.answer(bearer) }] });
    };
  }

  async function withGrant(run: (ctx: {
    mcp: ProviderMcp;
    store: SocialTokenStore;
    seen: Seen;
  }) => Promise<void>, opts: { answer: (bearer: string) => string; refreshed: string | null; tokenDelayMs?: number }) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-social-refresh-"));
    const store = new SocialTokenStore("zernio", home);
    store.write({
      tokens: { access_token: STALE, refresh_token: "rt-secret", token_type: "bearer", expires_at: Date.now() - 1000 },
      client: { client_id: "cid", redirect_uris: ["http://127.0.0.1:3000/api/social/oauth/callback"] },
      connectedAt: "2026-09-21T04:23:43.000Z",
      scopes: ["posts:read"],
    });
    const seen: Seen = { bearers: [], tokenPosts: 0 };
    const mcp = await connectProviderMcp({
      url: "https://mcp.example/mcp",
      authProvider: new LibiOAuthClientProvider({
        providerId: "zernio",
        store,
        redirectUrl: "http://127.0.0.1:3000/api/social/oauth/callback",
        scopes: ["posts:read"],
        onRedirect: () => {},
        interactive: false,
      }),
      fetch: fetchFor({ ...opts, seen }) as unknown as Parameters<typeof connectProviderMcp>[0]["fetch"],
    });
    try {
      await run({ mcp, store, seen });
    } finally {
      await mcp.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  const OK = JSON.stringify({ accountId: "a1", status: "healthy" });
  /** Verbatim from the live log of 2026-09-21T05:23:43Z. */
  const UNAUTHORIZED = "Error: [401] Unauthorized";
  /** The real behaviour: the stale token is rejected, the refreshed one works. */
  const staleIs401 = (bearer: string): string => (bearer === `Bearer ${FRESH}` ? OK : UNAUTHORIZED);

  it("the expired token is refreshed, the call is retried, and the caller never sees the 401", async () => {
    await withGrant(async ({ mcp, store, seen }) => {
      await expect(mcp.call("accounts_get_account_health", { account_id: "a1" })).resolves.toEqual({
        accountId: "a1",
        status: "healthy",
      });
      // Called twice: once with the stale token, once with the refreshed one.
      expect(seen.bearers).toEqual([`Bearer ${STALE}`, `Bearer ${FRESH}`]);
      expect(seen.tokenPosts).toBe(1);
      // The grant on disk is the NEW one — the live defect's signature was a
      // file that never changed.
      expect(store.readSecret()?.tokens.access_token).toBe(FRESH);
      expect(store.readSecret()?.tokens.refresh_token).toBe("rt-rotated");
      // Still connected, and not revoked.
      expect(store.status()).toMatchObject({ connected: true, revoked: false });
      // `connectedAt` is the sign-in's, not the refresh's: a refresh is not a
      // new connection and must not look like one in the UI.
      expect(store.status().connectedAt).toBe("2026-09-21T04:23:43.000Z");
    }, { answer: staleIs401, refreshed: FRESH });
  });

  it("an expiry that hits many in-flight calls at once refreshes exactly ONCE", async () => {
    await withGrant(async ({ mcp, seen }) => {
      const all = await Promise.all(
        Array.from({ length: 12 }, () => mcp.call("accounts_get_account_health", { account_id: "a1" })),
      );
      expect(all).toHaveLength(12);
      // THE assertion: twelve parallel refreshes of one grant is how a provider
      // that rotates refresh tokens ends up rejecting its own.
      expect(seen.tokenPosts).toBe(1);
      expect(seen.bearers.filter((b) => b === `Bearer ${STALE}`)).toHaveLength(12);
      expect(seen.bearers.filter((b) => b === `Bearer ${FRESH}`)).toHaveLength(12);
    }, { answer: staleIs401, refreshed: FRESH, tokenDelayMs: 25 });
  });

  it("retries ONCE — a 401 that survives a good refresh gives up instead of looping", async () => {
    await withGrant(async ({ mcp, store, seen }) => {
      await expect(mcp.call("accounts_get_account_health", { account_id: "a1" })).rejects.toMatchObject({
        kind: "unauthorized",
        status: 401,
      });
      expect(seen.bearers).toHaveLength(2);
      expect(seen.tokenPosts).toBe(1);
      // The refresh WORKED, so nothing was revoked — the grant stays.
      expect(store.status()).toMatchObject({ connected: true, revoked: false });
    }, { answer: () => UNAUTHORIZED, refreshed: FRESH });
  });

  it("a dead refresh token still clears the grant, marks it revoked, and reports unauthorized", async () => {
    await withGrant(async ({ mcp, store, seen }) => {
      await expect(mcp.call("accounts_get_account_health", { account_id: "a1" })).rejects.toMatchObject({
        kind: "unauthorized",
        status: 401,
      });
      expect(seen.tokenPosts).toBe(1);
      // Not retried: there was nothing to retry WITH.
      expect(seen.bearers).toHaveLength(1);
      expect(store.readSecret()).toBeNull();
      // Not "never connected" — this is what the Social page turns into
      // "libi's connection was revoked".
      expect(store.status()).toMatchObject({ connected: false, revoked: true });
    }, { answer: () => UNAUTHORIZED, refreshed: null });
  });

  it("a text-shaped 403 is never refreshed and never touches the grant", async () => {
    await withGrant(async ({ mcp, store, seen }) => {
      await expect(mcp.call("accounts_get_account_health", { account_id: "a1" })).rejects.toMatchObject({
        kind: "forbidden",
        status: 403,
      });
      // THE assertion for the other half of the seam: no refresh was attempted,
      // the call was not repeated, and the sign-in is untouched.
      expect(seen.tokenPosts).toBe(0);
      expect(seen.bearers).toHaveLength(1);
      expect(store.readSecret()?.tokens.access_token).toBe(STALE);
      expect(store.status()).toMatchObject({ connected: true, revoked: false });
    }, {
      answer: () => "Error: [403] This connector token has the 'ads' resource group disabled. (code: insufficient_permissions)",
      refreshed: FRESH,
    });
  });

  it("no token reaches the error a caller sees, on either outcome", async () => {
    await withGrant(async ({ mcp }) => {
      const err = (await mcp.call("accounts_get_account_health", { account_id: "a1" }).catch((e: unknown) => e)) as SocialError;
      expect(err.message).not.toContain(STALE);
      expect(err.message).not.toContain(FRESH);
      expect(err.message).not.toContain("rt-secret");
    }, { answer: () => UNAUTHORIZED, refreshed: null });
  });
});
