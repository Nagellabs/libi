import { ZERNIO_INPUT_SCHEMAS } from "./live-surface";

/**
 * The tool definitions the fake advertises, and the envelope it answers in.
 *
 * **Why plain JSON Schema and not `zod/v3`.** The repo rule (AGENTS.md → MCP)
 * exists because the SDK's ZOD→JSON conversion fails silently under zod v4 and
 * every tool disappears from `tools/list`. Nothing here runs that conversion:
 * this fake is served by the low-level `Server` (the same shape
 * `mcp/http/session.ts` uses), which takes JSON Schema and passes it straight
 * through. And these schemas are RECORDINGS — `additionalProperties: false`,
 * the `anyOf` string/null unions, the pydantic defaults — that a zod round
 * trip would quietly reshape, which is the one thing a strict fake may not do.
 *
 * Every schema below was read off the live `tools/list` on 2026-09-20.
 *
 * Descriptions are trimmed to their load-bearing parts: the DRAFT / IMMEDIATE /
 * SCHEDULED mode rules and the multi-account disambiguation rule are what
 * steer an agent, and a scenario that turns on the wrong one is a real finding.
 */

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

export interface FakeToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: Record<string, unknown>;
}

const S = { type: "string" } as const;
const B = (def = false) => ({ type: "boolean", default: def });
const I = (def: number) => ({ type: "integer", default: def });
const SD = (def = "") => ({ type: "string", default: def });
/** A pydantic `Optional[str] = None`, exactly as the live schemas print it. */
const OPT_S = { anyOf: [{ type: "string" }, { type: "null" }], default: null };
const FREE_OBJ_ARRAY = { anyOf: [{ items: { additionalProperties: true, type: "object" }, type: "array" }, { type: "null" }], default: null };

/**
 * Every generated Zernio tool declares `outputSchema: { result: string }` with
 * `x-fastmcp-wrap-result` (verified live, 2026-09-20), so the payload arrives
 * wrapped one level deep in a single `result` key holding a PYTHON REPR — not
 * JSON. `parseZernioPayload` is the production seam that reads it; a fake that
 * answered plain JSON would prove nothing about that seam.
 */
export const WRAPPED_RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { result: { type: "string" } },
  required: ["result"],
  "x-fastmcp-wrap-result": true,
  additionalProperties: false,
};

function obj(properties: Record<string, unknown>, required?: string[]): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

/** The curated schemas, verbatim. The KEYS must match `ZERNIO_INPUT_SCHEMAS`. */
const LISTED: Array<{ name: string; description: string; inputSchema: JsonSchema }> = [
  { name: "accounts_list", description: "List all connected social media accounts.\n\nReturns the platform, username, and account ID for each connected account.\nUse this to find account IDs needed for creating posts.", inputSchema: obj({}) },
  { name: "accounts_get", description: "Get account details for a specific platform.\n\nReturns username and ID for the first account matching the platform.", inputSchema: obj({ platform: { ...S, description: "Platform name: instagram, tiktok (required)" } }, ["platform"]) },
  { name: "accounts_get_account_health", description: "Check account health", inputSchema: obj({ account_id: { ...S, description: "The account ID to check (required)" } }, ["account_id"]) },
  { name: "accounts_get_follower_stats", description: "Get follower stats", inputSchema: obj({ account_ids: OPT_S, from_date: OPT_S, to_date: OPT_S, granularity: SD("daily"), profile_id: OPT_S }) },
  {
    name: "posts_create",
    description:
      "Create a social media post. Can be saved as DRAFT, SCHEDULED, or PUBLISHED immediately.\n\n" +
      "**DRAFT MODE (is_draft=True)** — the post is saved but NOT published and NOT scheduled.\n" +
      "**IMMEDIATE MODE (publish_now=True)** — the post goes live IMMEDIATELY.\n" +
      "**SCHEDULED MODE (default)** — use schedule_minutes to set the delay.\n\n" +
      "MULTI-ACCOUNT USERS: if the user has more than one account on the target platform you MUST pass " +
      "`account_id`. Call `accounts_list` first. Omitting it when several exist returns an error listing the candidates.",
    inputSchema: obj({
      content: { ...S, description: "The post text/content (required)" },
      platform: { ...S, description: "Target platform: instagram, tiktok (required)" },
      account_id: SD(),
      profile_id: SD(),
      media_urls: { ...SD(), description: "Comma-separated URLs of media files to attach" },
      title: SD(),
      is_draft: B(),
      publish_now: B(),
      schedule_minutes: I(0),
    }, ["content", "platform"]),
  },
  { name: "posts_get", description: "Get full details of a specific post including content, status, and scheduling info.", inputSchema: obj({ post_id: S }, ["post_id"]) },
  { name: "posts_list", description: "List posts with optional filtering by status.\n\nStatus options: draft, scheduled, published, failed", inputSchema: obj({ status: SD(), limit: I(10) }) },
  { name: "posts_update", description: "Update an existing post.\n\nOnly draft, scheduled, and failed posts can be updated.\nPublished posts cannot be modified.", inputSchema: obj({ post_id: S, content: SD(), title: SD(), scheduled_for: SD() }, ["post_id"]) },
  { name: "posts_delete", description: "Delete a post by ID.\n\nPublished posts cannot be deleted.", inputSchema: obj({ post_id: S }, ["post_id"]) },
  { name: "posts_retry", description: "Retry publishing a failed post. Only works on posts with 'failed' status.", inputSchema: obj({ post_id: S }, ["post_id"]) },
  {
    name: "posts_cross_post",
    description: "Post the same content to multiple platforms at once. Pass `account_ids` parallel to `platforms` to disambiguate.",
    inputSchema: obj({ content: S, platforms: S, account_ids: SD(), profile_id: SD(), media_urls: SD(), is_draft: B(), publish_now: B() }, ["content", "platforms"]),
  },
  { name: "posts_publish_now", description: "Publish a post immediately to a platform. The post goes live right away.", inputSchema: obj({ content: S, platform: S, account_id: SD(), profile_id: SD(), media_urls: SD() }, ["content", "platform"]) },
  { name: "posts_list_failed", description: "List all failed posts that can be retried.", inputSchema: obj({ limit: I(10) }) },
  {
    name: "analytics_get_analytics",
    description: "Get post analytics",
    inputSchema: obj({
      post_id: { ...OPT_S, description: "Returns analytics for a single post." },
      account_id: OPT_S, profile_id: OPT_S, platform: OPT_S,
      from_date: { ...OPT_S, description: "Inclusive lower bound (YYYY-MM-DD)." },
      to_date: { ...OPT_S, description: "Inclusive upper bound (YYYY-MM-DD)." },
      page: I(1), limit: I(50), order: SD("desc"), sort_by: SD("date"), source: SD("all"),
    }),
  },
  { name: "validate_post", description: "Validate post content", inputSchema: obj({ content: OPT_S, media_items: FREE_OBJ_ARRAY, platforms: { ...FREE_OBJ_ARRAY, description: "Target platforms (same format as POST /v1/posts) (required)" } }, ["platforms"]) },
  { name: "validate_media", description: "Validate media URL", inputSchema: obj({ url: { ...S, description: "Public media URL to validate (required)" } }, ["url"]) },
  { name: "call_tool", description: "Call a tool by name with the given arguments.\n\nUse this to execute tools discovered via search_tools.", inputSchema: obj({ name: S, arguments: { anyOf: [{ additionalProperties: true, type: "object" }, { type: "null" }], default: null } }, ["name"]) },
  { name: "search_tools", description: "Search for tools using natural language.\n\nReturns matching tool definitions ranked by relevance, in the same format as list_tools.", inputSchema: obj({ query: S }, ["query"]) },
  { name: "docs_search", description: "Search across the Zernio API documentation to find relevant information, code examples, API references, and guides.", inputSchema: obj({ query: S }, ["query"]) },
  { name: "zernio_overview", description: "Show an overview of what this Zernio MCP server can do (accounts, posts, analytics, ads, inbox) and how to find the right tool.", inputSchema: obj({}) },
];

/** What `tools/list` answers — the curated names and nothing else. */
export const LISTED_TOOL_DEFS: FakeToolDef[] = LISTED.map((t) => ({ ...t, outputSchema: WRAPPED_RESULT_SCHEMA }));

/**
 * The schema of an UNLISTED tool, derived from the recording so the advertised
 * shape and the validator cannot disagree. Nothing serves these over
 * `tools/list` — they exist for `search_tools`, which answers full tool
 * definitions (verified live).
 */
export function recordedInputSchema(name: string): JsonSchema {
  const rec = ZERNIO_INPUT_SCHEMAS[name];
  const properties: Record<string, unknown> = {};
  for (const key of rec?.properties ?? []) properties[key] = {};
  return { type: "object", properties, required: rec?.required ? [...rec.required] : undefined, additionalProperties: false };
}
