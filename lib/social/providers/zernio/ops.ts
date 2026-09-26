import { SocialError, errShape } from "@/lib/social/errors";
import { CALL_TOOL, type ProviderMcp } from "@/lib/social/mcp-client";
import { serverLogger as logger } from "@/lib/logger";

/**
 * Zernio operations the adapter needs → the tool names that implement them.
 *
 * NOT a pinned list. libi keeps no REST client for Zernio and vendors none of
 * its types: it is a CLIENT of Zernio's hosted MCP, so a Zernio API change is
 * a tool-name change.
 *
 * **`tools/list` does not decide which tool an op maps to.** Verified live on
 * 2026-09-20: Zernio advertises ~70 CURATED tools (`accounts_list`,
 * `posts_create`, `posts_get`, `posts_list`, …) plus `call_tool`,
 * `search_tools`, `docs_search` and `zernio_overview`. The full-shaped REST
 * tools libi actually needs — `accounts_list_accounts`, `posts_create_post`,
 * `posts_get_post`, `posts_list_posts`, `posts_update_post`,
 * `posts_delete_post`, `ad_accounts_list_ad_accounts`,
 * `ad_campaigns_list_ad_campaigns`, `media_get_media_presigned_url`,
 * `accounts_get_tik_tok_creator_info` — are **not listed at all** and are
 * reachable only by exact name through `call_tool`. Every one of them was
 * called successfully that way.
 *
 * So the first candidate is used AS IS, listed or not; `tools/list` is only
 * consulted to decide whether a DIRECT call is possible instead of a
 * `call_tool` hop (that decision lives in `mcp-client.ts#call`). An earlier
 * version preferred the first candidate the server listed, which meant the
 * curated prose tool beat the full-shaped one every time — `accounts.list`
 * resolved to `accounts_list`, whose prose answer `parseZernioPayload` cannot
 * read.
 *
 * Verified live against Zernio on 2026-09-20.
 */
export type ZernioOp =
  | "accounts.list" | "accounts.health" | "accounts.tiktokCreatorInfo"
  | "posts.list" | "posts.get" | "posts.create" | "posts.update" | "posts.delete" | "posts.retry"
  | "analytics.post" | "analytics.instagramStory" | "media.presign" | "validate.post" | "validate.media"
  | "ads.accounts" | "ads.campaigns" | "ads.list";

/**
 * Curated convenience tools that are LOSSY and must never implement an op, in
 * ANY code path. Each one shadows a confirmed full-shaped tool: it is
 * single-platform, and it flattens the answer to prose, dropping `metadata`,
 * `tiktokSettings` and `platformSpecificData`. Confirmed live on 2026-09-20 —
 * `accounts_list` answers "Found 2 connected account(s): - instagram: …", and
 * `posts_get` / `posts_list` do the same, so `parseZernioPayload` throws
 * "answered in a format libi cannot read" on every one of them.
 *
 * These are exactly the names `tools/list` DOES advertise, which is why the
 * deny list is not merely "don't name them as candidates": a rename, or a
 * `search_tools` hit, can put one in front of the resolver where nothing else
 * would stop it.
 *
 * `posts_retry` is deliberately absent. Its full-shaped twin does not exist
 * (see `posts.retry` below), so denying it would leave the op with no tool at
 * all — a deny list entry is a name nothing may EVER resolve to.
 */
export const ZERNIO_LOSSY_TOOLS: readonly string[] = [
  "accounts_list",
  "posts_create",
  "posts_get",
  "posts_list",
  "posts_update",
  "posts_delete",
  "posts_cross_post",
];

/**
 * What a tool DOES, as its name spells it. The bar a `search_tools` hit has to
 * clear before it may stand in for a renamed tool: a `get`/`list` tool can
 * never satisfy a create/update/delete/retry op, and a create/update/delete
 * tool can never satisfy a read.
 *
 * It classifies the VERB IN THE TOOL NAME, not the REST semantics — which is
 * why `media.presign` is `read`: Zernio spells it `media_get_media_presigned_url`.
 */
export type OpAction = "read" | "create" | "update" | "delete" | "retry";

/**
 * The verb segments that express each action in a Zernio tool name. A tool may
 * carry verbs from ONE action only — `posts_get_post` is a read and can never
 * answer for `posts.create`, whatever else its name contains.
 */
const ACTION_VERBS: Record<OpAction, readonly string[]> = {
  read: ["get", "list", "fetch", "search", "validate", "preview", "presigned", "presign"],
  create: ["create", "publish", "add", "schedule"],
  update: ["update", "edit", "patch", "move"],
  delete: ["delete", "remove", "unpublish", "cancel"],
  retry: ["retry"],
};

const ACTION_IDS = Object.keys(ACTION_VERBS) as OpAction[];

/**
 * Whether `name`'s verbs are the op's action and nothing else. A name carrying
 * no known verb at all fails too: an unrecognisable tool is not evidence of
 * anything, and adopting one is the substitution this bar exists to refuse.
 */
export function actionMatches(action: OpAction, name: string): boolean {
  const segments = new Set(name.toLowerCase().split("_"));
  let own = false;
  for (const candidate of ACTION_IDS) {
    const hit = ACTION_VERBS[candidate].some((v) => segments.has(v));
    if (!hit) continue;
    if (candidate !== action) return false;
    own = true;
  }
  return own;
}

export interface ZernioOpDef {
  /**
   * In preference order. The FIRST is used as is — it is the full-shaped tool,
   * and it is dispatched by exact name whether or not the server lists it. A
   * later candidate is only ever reached by rename recovery.
   */
  candidates: string[];
  /** The `search_tools` query for the rename recovery after a failed dispatch. */
  search: string;
  /**
   * The RESOURCE prefix any tool implementing this op must start with,
   * matched on whole underscore segments (`accounts_…`, `ad_campaigns_…`).
   *
   * It is what stops "list accounts" resolving to `ad_accounts_list_ad_accounts`
   * — an ad account is not an account — and it is per-op rather than derived
   * from the op id because Zernio's ads tools are prefixed `ad_`, not `ads_`.
   * It is the FULL resource, not just the first segment: `ad_campaigns` and
   * `ad_accounts` are different resources, and live, `ads.campaigns` resolved
   * to `ad_campaigns_list_ad_sets` while only the first segment was compared.
   */
  prefix: string;
  /** What the op DOES; a search hit whose verbs say otherwise is refused. */
  action: OpAction;
  /**
   * Arguments the tool REFUSES to run without. Recorded here so a caller does
   * not have to discover a 400 at runtime; verified live on 2026-09-20.
   */
  requiredArgs?: string[];
}

export const ZERNIO_OPS: Record<ZernioOp, ZernioOpDef> = {
  // `accounts_list_accounts` takes `profile_id`, `platform`, `status`, and
  // `page` + `limit` — which must be sent TOGETHER or the call is a 400. They
  // are not in `requiredArgs` because neither is required on its own; the
  // pairing is the constraint. The curated `accounts_list` is NOT a fallback
  // candidate any more: it is prose, it is denied, and having it here is what
  // made the live resolver pick it.
  "accounts.list":              { candidates: ["accounts_list_accounts"], search: "list accounts", prefix: "accounts", action: "read" },
  "accounts.health":            { candidates: ["accounts_get_account_health"], search: "account health", prefix: "accounts", action: "read" },
  "accounts.tiktokCreatorInfo": { candidates: ["accounts_get_tik_tok_creator_info"], search: "tiktok creator info", prefix: "accounts", action: "read" },
  "posts.list":                 { candidates: ["posts_list_posts"], search: "list posts", prefix: "posts", action: "read" },
  "posts.get":                  { candidates: ["posts_get_post"], search: "get post", prefix: "posts", action: "read" },
  "posts.create":               { candidates: ["posts_create_post"], search: "create post", prefix: "posts", action: "create" },
  "posts.update":               { candidates: ["posts_update_post"], search: "update post", prefix: "posts", action: "update" },
  "posts.delete":               { candidates: ["posts_delete_post"], search: "delete post", prefix: "posts", action: "delete" },
  // The one op with no full-shaped tool. `posts_retry_post` was a guess, and
  // on 2026-09-20 `call_tool` answered `Unknown tool: 'posts_retry_post'` for
  // it — so the curated `posts_retry` LEADS here, because a candidate list
  // must not lead with a name that does not exist. `posts_retry_post` stays
  // behind it in case Zernio generates the full shape later; it is not denied,
  // since denying the only tool that exists would leave the op unreachable.
  // STAGE A: `posts_retry`'s answer shape is still unread — if it is prose,
  // `parseZernioPayload` will say so loudly rather than inventing a post.
  "posts.retry":                { candidates: ["posts_retry", "posts_retry_post"], search: "retry post", prefix: "posts", action: "retry" },
  "analytics.post":             { candidates: ["analytics_get_analytics"], search: "post analytics", prefix: "analytics", action: "read" },
  // Instagram STORIES are not in the post-analytics sync at all — measured
  // 2026-09-21: a story published at 07:59 was still `syncStatus: "pending"`
  // eight hours and one completed sync cycle later, and the account's own
  // analytics list did not contain it. Story metrics come only from this
  // separate endpoint, keyed by the story's INSTAGRAM media id (the target's
  // `platformPostId`), not by the Zernio post id.
  "analytics.instagramStory":   { candidates: ["instagram_get_instagram_story_insights"], search: "instagram story insights", prefix: "instagram", action: "read", requiredArgs: ["account_id", "story_id"] },
  "media.presign":              { candidates: ["media_get_media_presigned_url"], search: "presigned upload url", prefix: "media", action: "read" },
  "validate.post":              { candidates: ["validate_post"], search: "validate post", prefix: "validate", action: "read" },
  "validate.media":             { candidates: ["validate_media"], search: "validate media", prefix: "validate", action: "read" },
  // Ad accounts are per connected account, not global: without `account_id`
  // (a Zernio SOCIAL-account id) the tool refuses. Verified live.
  "ads.accounts":               { candidates: ["ad_accounts_list_ad_accounts"], search: "list ad accounts", prefix: "ad_accounts", action: "read", requiredArgs: ["account_id"] },
  "ads.campaigns":              { candidates: ["ad_campaigns_list_ad_campaigns"], search: "list ad campaigns", prefix: "ad_campaigns", action: "read" },
  // Individual ADS, not campaigns. This is what ties an ad to a piece: it
  // filters by `effective_instagram_media_id` / `effective_object_story_id`,
  // which its own description calls the way to "map a Business-Manager-visible
  // IG post back to the Zernio ad" — and those are exactly the ids a published
  // Instagram/Facebook target already carries as `platformPostId`.
  // Verified live 2026-09-21 that it answers cleanly with NO ads account
  // connected: `{'ads': [], 'pagination': {...}}`, not an error — so an empty
  // ads section is a normal state rather than a failure to explain away.
  "ads.list":                   { candidates: ["ad_campaigns_list_ads"], search: "list ads", prefix: "ad_campaigns", action: "read" },
};

export const ZERNIO_OP_IDS = Object.keys(ZERNIO_OPS) as ZernioOp[];

/** Zernio's own runtime tool-search tool — how a renamed tool is found. */
export const SEARCH_TOOLS = "search_tools";

export interface OpResolution {
  resolved: Partial<Record<ZernioOp, string>>;
  /** Ops with no reachable tool — `toolForOp` throws for these. */
  missing: ZernioOp[];
  /** Ops whose tool was found by `search_tools` after a dispatch failed. */
  discovered: Partial<Record<ZernioOp, string>>;
}

/**
 * Resolve every op against a tool list, with no network of its own.
 *
 * The chosen name is always the FIRST candidate, listed or not: the tools libi
 * needs live in Zernio's unlisted long tail and are reached by exact name
 * through `call_tool`. The tool list answers exactly one question — is there
 * any way to dispatch at all? An op is `missing` only when there is not: the
 * server lists neither the tool nor `call_tool`.
 *
 * It deliberately does NOT search. `search_tools` ranking is unreliable — on
 * 2026-09-20 "list accounts" answered with six `ad_accounts_*` tools and never
 * mentioned `accounts_list_accounts` — so an op's absence from a search result
 * is no evidence the tool is gone. Treating it as evidence would mark a
 * perfectly working op `unsupported` on the live server. Recovery is triggered
 * by a dispatch that actually failed; see `callOp`.
 */
export function resolveOps(names: string[]): OpResolution {
  const listed = new Set(names);
  const canDispatch = listed.has(CALL_TOOL);
  const resolved: Partial<Record<ZernioOp, string>> = {};
  const missing: ZernioOp[] = [];
  for (const op of ZERNIO_OP_IDS) {
    const chosen = ZERNIO_OPS[op].candidates[0];
    resolved[op] = chosen;
    if (!canDispatch && !listed.has(chosen)) missing.push(op);
  }
  return { resolved, missing, discovered: {} };
}

/**
 * The live resolution. One `tools/list`, no searching — see `resolveOps` for
 * why the tool list cannot decide which tool an op maps to.
 */
export async function resolveOpsFromServer(mcp: ProviderMcp): Promise<OpResolution> {
  return resolveOps(await mcp.listToolNames());
}

/**
 * Tool names out of a `search_tools` result. Verified live on 2026-09-20: it
 * answers an ARRAY of full tool definitions, each with `name`, `title`,
 * `description`, `inputSchema` and `annotations`.
 *
 * Read narrowly on purpose. An earlier version mined prose for snake_case
 * words and accepted several wrapper keys, which meant a result shape libi had
 * guessed wrong could still produce a plausible-looking name — the exact
 * silent-wrong-answer the resolver exists to prevent. A shape this does not
 * recognise yields nothing, and recovery fails loudly.
 */
export function toolNamesFromSearch(payload: unknown): string[] {
  const items = Array.isArray(payload) ? payload : [];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === "string") out.push(item);
    else if (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string") {
      out.push((item as { name: string }).name);
    }
  }
  return [...new Set(out)];
}

/**
 * Pick a search hit that plausibly IS the op, or nothing.
 *
 * Four rules, all about NOT accepting a near-miss. A hit must
 *  - not be a denied prose tool;
 *  - not be the name that just failed;
 *  - share the op's resource `prefix`, so a search for "list accounts" cannot
 *    answer with the ads tool (live, it answers with six of them);
 *  - carry the op's ACTION and no other, so "create post" cannot answer with
 *    `posts_get_post` and "get post" cannot answer with `posts_delete_post`.
 *    Zernio's own ranking put `posts_update_post` above `posts_create_post`
 *    for "create post", so ranking alone decides nothing here.
 *
 * Among the hits that clear the bar, the winner is the one matching the most
 * whole search SEGMENTS — `posts_create_post` (create + post) beats
 * `posts_quick_create` (create), which substring matching got backwards. There
 * is no length tie-break: it looked like a preference for the full-shaped tool
 * but was really "the longest name wins", which a rename flips at random.
 */
function pickFromSearch(def: ZernioOpDef, hits: string[], failed: string): string | undefined {
  const terms = def.search.toLowerCase().split(/\s+/).filter(Boolean);
  const head = `${def.prefix}_`;
  // Scored on what comes AFTER the resource prefix. Counting the prefix would
  // give `ad_campaigns_list_ad_sets` the same score as
  // `ad_campaigns_list_ad_campaigns` for "list ad campaigns", which is exactly
  // the wrong-resource resolution seen live.
  const score = (name: string): number => {
    const lower = name.toLowerCase();
    if (!lower.startsWith(head)) return 0;
    const segments = lower.slice(head.length).split("_");
    return terms.filter((t) => segments.includes(t)).length;
  };
  // The bar: a hit must describe the op AT LEAST AS WELL as the name libi was
  // built against. `ad_campaigns_list_ad_sets` scores below
  // `ad_campaigns_list_ad_campaigns` (it matches "list" and "ad", not
  // "campaigns"), so it cannot stand in for it — a renamed tool keeps the
  // resource it reads, only the spelling moves.
  const floor = Math.max(1, score(failed));
  let best: string | undefined;
  let bestScore = 0;
  for (const name of hits) {
    if (ZERNIO_LOSSY_TOOLS.includes(name)) continue;
    if (name === failed) continue;
    if (!actionMatches(def.action, name)) continue;
    const s = score(name);
    if (s < floor || s <= bestScore) continue;
    bestScore = s;
    best = name;
  }
  return best;
}

function unsupportedForOp(op: ZernioOp, tried: string[]): SocialError {
  const def = ZERNIO_OPS[op];
  // The kind is `unsupported`, NOT `provider`: `provider` is retryable and
  // maps to 502, so a structural misconfiguration — a renamed tool, a stale
  // candidate list — would retry forever while reading as a transient blip.
  return new SocialError(
    "unsupported",
    `Zernio exposes no tool for "${op}". Tried ${tried.map((c) => `"${c}"`).join(", ")}, ` +
      `then asked ${SEARCH_TOOLS} for "${def.search}"; no answer was the same operation ` +
      `(it must start with "${def.prefix}_" and be a ${def.action}). ` +
      `Reconnect Zernio, or update ZERNIO_OPS in lib/social/providers/zernio/ops.ts if the tool was renamed.`,
  );
}

/**
 * Zernio's answer when `call_tool` is handed a name it does not know:
 * `Unknown tool: 'posts_retry_post'` (observed live, 2026-09-20). It is the
 * ONE signal that a candidate has been renamed away — and it is also the
 * guarantee that nothing ran, which is why recovering and retrying is safe
 * even on a write.
 */
export function isUnknownToolError(err: unknown, name: string): boolean {
  if (!(err instanceof SocialError)) return false;
  if (!/unknown tool|tool not found|no such tool/i.test(err.message)) return false;
  return err.message.includes(name);
}

/**
 * Rename recovery: ONE `search_tools`, and a hit is adopted only when it
 * plausibly is the same operation. Never a substitution — an op whose tool is
 * genuinely gone fails as `unsupported`, naming what was tried and searched,
 * rather than quietly calling something else.
 *
 * A `search_tools` that throws is not leniency here the way it was in the old
 * pre-flight: this path is only reached because a dispatch already failed, so
 * there is nothing left to be lenient about except the op's own remaining
 * candidates.
 */
export async function recoverOp(mcp: ProviderMcp, op: ZernioOp, failed: string): Promise<string> {
  const def = ZERNIO_OPS[op];
  let hits: string[] = [];
  try {
    hits = toolNamesFromSearch(await mcp.call(SEARCH_TOOLS, { query: def.search }));
  } catch (err) {
    logger.warn({ tag: "social", op: "zernio.search_failed", zernioOp: op, ...errShape(err) }, "search_tools failed");
  }
  // A remaining candidate is a name libi declared for this op, so it is not a
  // substitution: confirmed by the search first, then tried unconfirmed.
  const remaining = def.candidates.filter((c) => c !== failed);
  const found = remaining.find((c) => hits.includes(c)) ?? pickFromSearch(def, hits, failed) ?? remaining[0];
  if (!found) {
    logger.warn(
      { tag: "social", op: "zernio.op_unresolved", zernioOp: op, candidate: failed, query: def.search, hits: hits.length },
      "no Zernio tool implements this op",
    );
    throw unsupportedForOp(op, [failed]);
  }
  logger.info({ tag: "social", op: "zernio.op_discovered", zernioOp: op, tool: found, after: failed }, "op re-resolved after an unknown-tool failure");
  return found;
}

/**
 * The name to call for an op, or a loud failure. Never a silent fallback to a
 * convenience tool: an op libi cannot reach is an op the UI must be told about.
 */
export function toolForOp(res: OpResolution, op: ZernioOp): string {
  const name = res.resolved[op];
  if (name && !res.missing.includes(op) && !ZERNIO_LOSSY_TOOLS.includes(name)) return name;
  throw unsupportedForOp(op, ZERNIO_OPS[op].candidates);
}

/**
 * Dispatch an op: the exact resolved name, and — only if the server says it
 * does not know that name — ONE conservative rename recovery, then a single
 * retry. The recovered name is written back into `res`, which the adapter
 * memoizes, so the next call goes straight there.
 *
 * Retrying a write here is safe by construction: `Unknown tool` means Zernio
 * never dispatched anything.
 */
export async function callOp<X = unknown>(
  mcp: ProviderMcp,
  res: OpResolution,
  op: ZernioOp,
  args: Record<string, unknown>,
): Promise<X> {
  const name = toolForOp(res, op);
  try {
    return await mcp.call<X>(name, args);
  } catch (err) {
    if (!isUnknownToolError(err, name)) throw err;
    const found = await recoverOp(mcp, op, name);
    res.resolved[op] = found;
    res.discovered[op] = found;
    return mcp.call<X>(found, args);
  }
}
