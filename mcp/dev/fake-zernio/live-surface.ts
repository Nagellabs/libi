/**
 * What Zernio's hosted MCP ACTUALLY does — the recorded truth, in one place.
 *
 * This module is the single source shared by the two fakes:
 *
 *  - `__tests__/helpers/zernio-fake.ts`, the in-process `ProviderMcp` double
 *    the `lib/social` unit tests run against;
 *  - `mcp/dev/fake-zernio/**`, the HTTP server test mode puts in front of the
 *    agent AND libi's own client.
 *
 * They MUST NOT drift. A permissive fake is what let three breaking
 * assumptions ship green for two whole tasks — a `headers` argument the live
 * tools reject outright, a camelCase write body they reject outright, and the
 * `{ "result": "<Python repr>" }` envelope every live answer arrives in — and
 * a fourth (the resolver preferring whatever `tools/list` advertised) was
 * found only by calling the live server. Every constant below exists to make
 * one of those impossible to miss.
 *
 * Everything here was read off the live server on 2026-09-20 against the
 * user's own account. Anything that was NOT is called out as unverified where
 * it is used; nothing is invented here.
 */

/**
 * What Zernio's `tools/list` really advertises: the CURATED tools plus the
 * four meta tools. Every full-shaped REST tool libi actually uses is ABSENT
 * from it — that is the whole point of this constant.
 *
 * A fake that listed the full-shaped names is what hid the resolver defect:
 * the resolver preferred whatever the server listed, so on the live server it
 * picked the curated prose tool (`accounts_list`) and the call came back in a
 * format libi cannot read. Only the names below may appear here.
 */
export const CURATED_TOOLS = [
  "accounts_list", "accounts_get", "accounts_get_account_health", "accounts_get_follower_stats",
  "posts_create", "posts_get", "posts_list", "posts_update", "posts_delete", "posts_retry",
  "posts_cross_post", "posts_publish_now", "posts_list_failed",
  "analytics_get_analytics", "validate_post", "validate_media",
  "call_tool", "search_tools", "docs_search", "zernio_overview",
];

/**
 * The full-shaped REST tools: NOT listed, reachable only by exact name
 * through `call_tool`. Every one was called successfully that way on
 * 2026-09-20.
 *
 * `posts_retry_post` is deliberately absent: `call_tool` answered
 * `Unknown tool: 'posts_retry_post'` for it, which is why `posts.retry` leads
 * with the curated `posts_retry` in `ZERNIO_OPS`.
 */
export const FULL_SHAPED_TOOLS = [
  "accounts_list_accounts", "accounts_get_tik_tok_creator_info",
  "posts_list_posts", "posts_get_post", "posts_create_post", "posts_update_post", "posts_delete_post",
  "media_get_media_presigned_url",
  // Instagram Stories are absent from the post-analytics sync entirely, so
  // this is the only tool that can report on one. Unlisted like the rest of
  // the REST surface — `search_tools` finds it, `tools/list` does not carry it.
  "instagram_get_instagram_story_insights",
  "ad_accounts_list_ad_accounts", "ad_campaigns_list_ad_campaigns", "ad_campaigns_list_ads",
  // Music, found by search_tools 2026-09-27; the TikTok one answered live.
  "accounts_list_tik_tok_commercial_music", "instagram_search_instagram_audio", "instagram_get_instagram_audio",
];

/** What the server lists. The default for both fakes, as it is live. */
export const LIVE_TOOLS = CURATED_TOOLS;

/** Every name `call_tool` can reach — listed or not. Anything else is unknown. */
export const REACHABLE_TOOLS = [...CURATED_TOOLS, ...FULL_SHAPED_TOOLS];

/**
 * Zernio's own words when `call_tool` is handed a name it does not know
 * (observed live, 2026-09-20). `isUnknownToolError` keys on this, and the
 * resolver's single recovery attempt keys on that — so a fake has to say it
 * verbatim.
 */
export function unknownToolText(name: string): string {
  return `Unknown tool: '${name}'`;
}

/**
 * The top-level argument names each tool accepts.
 *
 * The full-shaped entries were read off the live `inputSchema`s on
 * 2026-09-20; the curated entries off the live `tools/list` on the same day.
 * EVERY one of these schemas is `additionalProperties: false`, which is the
 * whole point of recording them: a key not in this list is not ignored by
 * Zernio, it fails the call.
 *
 * Nested objects (`platforms[]`, `media_items[]`, `metadata`,
 * `tiktok_settings`) are declared `additionalProperties: true` free-form, so
 * nothing inside them is checked — and nothing inside them should be renamed.
 *
 * A tool with no entry here is not validated; say so rather than pretending.
 */
export const ZERNIO_INPUT_SCHEMAS: Record<string, { properties: readonly string[]; required?: readonly string[] }> = {
  // --- the full-shaped long tail (unlisted; `call_tool` only) ---------------
  posts_create_post: {
    properties: [
      "title", "content", "media_items", "platforms", "scheduled_for", "publish_now", "is_draft", "dry_run",
      "timezone", "tags", "hashtags", "mentions", "crossposting_enabled", "metadata", "tiktok_settings",
      "facebook_settings", "recycling", "queued_from_profile", "queue_id",
    ],
  },
  posts_update_post: {
    properties: [
      "post_id", "title", "content", "media_items", "platforms", "scheduled_for", "publish_now", "is_draft",
      "timezone", "visibility", "tags", "hashtags", "mentions", "crossposting_enabled", "metadata",
      "queued_from_profile", "queue_id", "tiktok_settings", "facebook_settings", "recycling",
    ],
    required: ["post_id"],
  },
  posts_get_post: { properties: ["post_id"], required: ["post_id"] },
  posts_delete_post: { properties: ["post_id"], required: ["post_id"] },
  posts_list_posts: {
    properties: ["account_id", "date_from", "date_to", "profile_id", "include_hidden", "sort_by", "search", "source", "status", "platform", "page", "limit"],
  },
  accounts_list_accounts: { properties: ["profile_id", "platform", "status", "page", "limit"] },
  accounts_get_tik_tok_creator_info: { properties: ["account_id"], required: ["account_id"] },
  media_get_media_presigned_url: { properties: ["filename", "content_type", "size"] },
  ad_accounts_list_ad_accounts: { properties: ["account_id"], required: ["account_id"] },
  ad_campaigns_list_ad_campaigns: { properties: ["account_id", "ad_account_id"] },
  accounts_list_tik_tok_commercial_music: { properties: ["account_id", "country_code"], required: ["account_id"] },
  instagram_search_instagram_audio: { properties: ["account_id", "audio_type", "q"], required: ["account_id", "audio_type"] },
  instagram_get_instagram_audio: { properties: ["account_id", "audio_id"], required: ["account_id", "audio_id"] },

  // --- the curated tools `tools/list` advertises ---------------------------
  accounts_list: { properties: [] },
  accounts_get: { properties: ["platform"], required: ["platform"] },
  accounts_get_account_health: { properties: ["account_id"], required: ["account_id"] },
  accounts_get_follower_stats: { properties: ["account_ids", "from_date", "to_date", "granularity", "profile_id"] },
  posts_create: {
    properties: ["content", "platform", "account_id", "profile_id", "media_urls", "title", "is_draft", "publish_now", "schedule_minutes"],
    required: ["content", "platform"],
  },
  posts_get: { properties: ["post_id"], required: ["post_id"] },
  posts_list: { properties: ["status", "limit"] },
  posts_update: { properties: ["post_id", "content", "title", "scheduled_for"], required: ["post_id"] },
  posts_delete: { properties: ["post_id"], required: ["post_id"] },
  posts_retry: { properties: ["post_id"], required: ["post_id"] },
  posts_cross_post: {
    properties: ["content", "platforms", "account_ids", "profile_id", "media_urls", "is_draft", "publish_now"],
    required: ["content", "platforms"],
  },
  posts_publish_now: { properties: ["content", "platform", "account_id", "profile_id", "media_urls"], required: ["content", "platform"] },
  posts_list_failed: { properties: ["limit"] },
  // NB the date arguments here are `from_date` / `to_date`, the opposite
  // spelling to `posts_list_posts`. That is Zernio's, not a typo.
  analytics_get_analytics: {
    properties: ["post_id", "account_id", "profile_id", "platform", "from_date", "to_date", "page", "limit", "order", "sort_by", "source"],
  },
  instagram_get_instagram_story_insights: { properties: ["account_id", "story_id"], required: ["account_id", "story_id"] },
  ad_campaigns_list_ads: {
    properties: [
      "page", "limit", "source", "status", "platform", "account_id", "ad_account_id", "page_id", "profile_id",
      "campaign_id", "ad_set_id", "platform_ad_id", "effective_object_story_id", "effective_instagram_media_id",
      "from_date", "to_date",
    ],
  },
  // `validate_post` takes THREE arguments and nothing else — notably no
  // `tags`, `metadata` or `is_draft`. Handing it a whole create body is a
  // rejected call, not a tolerated one.
  validate_post: { properties: ["content", "media_items", "platforms"], required: ["platforms"] },
  validate_media: { properties: ["url"], required: ["url"] },
  search_tools: { properties: ["query"], required: ["query"] },
  call_tool: { properties: ["name", "arguments"], required: ["name"] },
  docs_search: { properties: ["query"], required: ["query"] },
  zernio_overview: { properties: [] },
};

/** Python's own quoting rule: prefer `'`, switch to `"` when the value holds a `'`. */
function pyStr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .split(quote)
    .join(`\\${quote}`);
  return `${quote}${escaped}${quote}`;
}

/** A JS value as Python would print it — what rides inside the `result` string. */
export function pythonRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return pyStr(value);
  if (Array.isArray(value)) return `[${value.map(pythonRepr).join(", ")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${pyStr(k)}: ${pythonRepr(v)}`)
    .join(", ")}}`;
}

/**
 * The live rejection, verbatim in shape: pydantic validates the generated
 * tool's arguments and the call fails before anything is created.
 *
 *     1 validation error for call[posts_create_post]
 *     headers  Unexpected keyword argument
 *
 * `null` when the arguments are acceptable.
 */
export function validationErrorText(name: string, args: Record<string, unknown>): string | null {
  const schema = ZERNIO_INPUT_SCHEMAS[name];
  if (!schema) return null;
  const unknown = Object.keys(args).filter((k) => !schema.properties.includes(k));
  const missing = (schema.required ?? []).filter((k) => args[k] === undefined);
  if (unknown.length === 0 && missing.length === 0) return null;
  const lines = [
    ...unknown.map((k) => `${k}  Unexpected keyword argument`),
    ...missing.map((k) => `${k}  Field required`),
  ];
  const count = lines.length === 1 ? "1 validation error" : `${lines.length} validation errors`;
  return `${count} for call[${name}]\n${lines.join("\n")}`;
}
