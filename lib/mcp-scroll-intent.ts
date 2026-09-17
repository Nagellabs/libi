/**
 * The hand-off between `libi.show_extension` (which arrives as a
 * `navigate_agents` SSE broadcast, handled in `lib/editor-state-context.tsx`)
 * and the card it wants scrolled into view (`McpServersView`).
 *
 * A window CustomEvent alone is not enough. `McpServersView` lives inside the
 * `mcp` tab panel, and base-ui's `Tabs.Panel` defaults to `keepMounted: false`
 * — so whenever the user is on the Skills tab (the DEFAULT tab) the view is
 * unmounted, its `libi:mcp-scroll-to` listener does not exist, and the event
 * the agent triggered is dropped on the floor. The agent then says "I've opened
 * the card for you" and nothing moves.
 *
 * So the id is ALSO parked here, in module state the whole client bundle
 * shares, and the view claims it when it mounts. `takePendingMcpScroll` is
 * one-shot: an intent is consumed once and never replayed on a later,
 * unrelated visit to the page.
 */

/** The same-tab fast path: dispatched (and listened for) when the view is up. */
export const MCP_SCROLL_EVENT = "libi:mcp-scroll-to";

/**
 * How long a parked intent stays claimable. Long enough for a route push plus
 * the extensions query that renders the cards; short enough that a page opened
 * minutes later does not jump for a request the user has forgotten.
 */
const INTENT_TTL_MS = 30_000;

let pending: { mcpId: string; at: number } | null = null;

/** Park an intent for a view that may not be mounted yet. No-ops without an id. */
export function setPendingMcpScroll(mcpId: string | undefined, now = Date.now()): void {
  pending = mcpId ? { mcpId, at: now } : null;
}

/** Claim a parked intent, if one is still fresh. One-shot. */
export function takePendingMcpScroll(now = Date.now()): string | null {
  const claimed = pending;
  pending = null;
  if (!claimed) return null;
  return now - claimed.at <= INTENT_TTL_MS ? claimed.mcpId : null;
}
