import { parseMcpToolId, type McpToolId } from "@/lib/agents/mcp-tool-id";

/**
 * Zernio tools whose completion changes what the Social page shows. Reads are
 * deliberately absent: an invalidation fired by `posts_list_posts` would
 * refetch the very list that read was part of.
 *
 * Both spellings of each write are listed because the provider's MCP exposes
 * generated names (`posts_create_post`) alongside the shorter aliases its own
 * docs use (`posts_create`), and which one the agent picks is not libi's to
 * decide.
 */
export const ZERNIO_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "posts_create_post",
  "posts_create",
  "posts_update_post",
  "posts_update",
  "posts_edit_post",
  "posts_delete_post",
  "posts_delete",
  "posts_publish_now",
  "posts_retry_post",
  "posts_retry",
  "posts_retry_all_failed",
  "posts_cross_post",
  "posts_unpublish_post",
  "posts_bulk_upload_posts",
  "posts_sync_external_post",
  "call_tool",
]);

/** Ads have no libi write path — the agent is the only one that changes them,
 *  which is exactly why the agent's ads writes have to reach the Ads tab. The
 *  verb is matched rather than the whole name because the ads surface is the
 *  part of Zernio libi has verified the least (no ad account was connected —
 *  `.superpowers/sdd/zernio-live-shapes.md`), so an exhaustive list here would
 *  be a guess. Reads (`*_list_*`, `*_get_*`) never match. */
const AD_WRITE = /^(ad_campaigns_|ad_sets_|ads_)(create|update|delete|duplicate|set|pause|resume|boost|bulk)/;

/**
 * In-app chats: libi already observes every agent tool call with its server
 * and tool (`toolIdForCall`). A completed zernio WRITE invalidates the social
 * queries over the existing SSE stream — no polling needed for that path, and
 * no second EventSource.
 *
 * `call_tool` is counted as a write because its target is opaque here; one
 * extra refetch is cheaper than a stale dashboard.
 *
 * The id must have come through `toolIdForCall` — never a codex tool call's
 * TITLE, whose shape has changed twice.
 */
export function socialRefreshForTool(toolId: McpToolId | null): { queryKey: "social" } | null {
  if (!toolId) return null;
  const parsed = parseMcpToolId(toolId);
  if (!parsed || parsed.serverId.toLowerCase() !== "zernio") return null;
  const tool = parsed.toolName;
  return ZERNIO_WRITE_TOOLS.has(tool) || AD_WRITE.test(tool) ? { queryKey: "social" } : null;
}
