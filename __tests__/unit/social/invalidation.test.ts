/**
 * The in-app refresh path: libi already sees every tool call the agent makes,
 * so a completed zernio WRITE is enough to invalidate the social queries over
 * the SSE stream that is already open. What must never happen is the reverse —
 * a READ (`posts_list_posts`, `accounts_list`) firing an invalidation, which
 * would refetch the list that read was part of, on a loop.
 *
 * Both wire shapes are exercised through `toolIdForCall`, never a hand-built
 * id: claude's `mcp__zernio__<tool>` and codex's structured
 * `rawInput { server, tool }`. Canonicalizing from a codex TITLE is what this
 * repo has already been bitten by twice.
 */
import { describe, it, expect } from "vitest";
import { socialRefreshForTool } from "@/lib/social/invalidation";
import { toolIdForCall, makeMcpToolId } from "@/lib/agents/mcp-tool-id";

describe("socialRefreshForTool", () => {
  it("fires for zernio writes on both wire shapes, not for reads, not for other servers", () => {
    expect(socialRefreshForTool(toolIdForCall("mcp__zernio__posts_create_post", {}))).toEqual({ queryKey: "social" });
    expect(
      socialRefreshForTool(
        toolIdForCall("mcp.zernio.posts_update", { server: "zernio", tool: "posts_update", arguments: {} }),
      ),
    ).toEqual({ queryKey: "social" });
    expect(socialRefreshForTool(toolIdForCall("mcp__zernio__posts_list_posts", {}))).toBeNull();
    expect(socialRefreshForTool(toolIdForCall("mcp__zernio__accounts_list", {}))).toBeNull();
    expect(socialRefreshForTool(makeMcpToolId("libi", "libi.post_piece"))).toBeNull();
    expect(socialRefreshForTool(toolIdForCall("mcp__zernio__ad_campaigns_update_campaign_status", {}))).toEqual({
      queryKey: "social",
    });
    expect(socialRefreshForTool(null)).toBeNull();
  });

  it("treats every ads WRITE verb as a write and every ads READ as a read", () => {
    for (const tool of [
      "ad_campaigns_create_campaign",
      "ad_campaigns_pause_campaign",
      "ad_sets_update_ad_set",
      "ads_duplicate_ad",
      "ads_bulk_update",
    ]) {
      expect(socialRefreshForTool(toolIdForCall(`mcp__zernio__${tool}`, {}))).toEqual({ queryKey: "social" });
    }
    for (const tool of [
      "ad_campaigns_list_ad_campaigns",
      "ad_accounts_list_ad_accounts",
      "ads_get_ad",
      "analytics_get_analytics",
      "media_generate_upload_link",
    ]) {
      expect(socialRefreshForTool(toolIdForCall(`mcp__zernio__${tool}`, {}))).toBeNull();
    }
  });

  it("counts the opaque `call_tool` dispatcher as a write", () => {
    // Its target is not knowable from here; one extra refetch beats a stale
    // dashboard after the agent posts through it.
    expect(socialRefreshForTool(toolIdForCall("mcp__zernio__call_tool", {}))).toEqual({ queryKey: "social" });
  });

  it("does not match a different server whose tool name happens to collide", () => {
    expect(socialRefreshForTool(makeMcpToolId("some-other-scheduler", "posts_create_post"))).toBeNull();
  });
});
