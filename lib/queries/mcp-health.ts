import { useQuery } from "@tanstack/react-query";

import type { SessionsBy } from "@/mcp/http/session-summary";

// ── Types ───────────────────────────────────────────────────────────

/**
 * What `GET /api/mcp/health` answers. `url` and `childStatus` are always
 * present — the route adds them either side of the proxied `/healthz` body —
 * so the card can name the endpoint it could not reach.
 */
export type McpHealth = {
  ok: boolean;
  url: string;
  childStatus: "running" | "restarting" | "gave-up" | "stopped" | "unknown";
  version?: string;
  port?: number;
  sessions?: number;
  sessionsBy?: SessionsBy;
  error?: string;
};

// ── Query keys ──────────────────────────────────────────────────────

export const mcpHealthKeys = {
  all: ["mcp-health"] as const,
};

// ── Queries ─────────────────────────────────────────────────────────

/**
 * Polls the aggregator's health while a surface that shows it is mounted.
 *
 * `enabled` exists because this card is not the only caller: the MCP list
 * renders one card per server, and every one of them would otherwise start a
 * five-second poll for an endpoint only libi's own card reports on.
 *
 * A 503 is a legitimate ANSWER here, not a failure: it carries the error text
 * the dot's tooltip renders. So the response body is returned either way and
 * the query never throws — throwing would blank the card behind React Query's
 * retry/backoff exactly when it has something to say.
 */
export function useMcpHealth({
  enabled = true,
  refetchInterval = 5000,
}: {
  enabled?: boolean;
  /** How often this observer polls. A surface that only needs to notice the
   *  endpoint giving up (the chat's banner) passes a slower interval than the
   *  cards that report on it live. */
  refetchInterval?: number;
} = {}) {
  return useQuery({
    enabled,
    queryKey: mcpHealthKeys.all,
    queryFn: async (): Promise<McpHealth> => {
      const res = await fetch("/api/mcp/health");
      return (await res.json()) as McpHealth;
    },
    refetchInterval,
  });
}

/**
 * The libi MCP tab's "Active sessions" line. It has its own key so its 5 s
 * poll runs only while that surface is visible, independent of every other
 * `useMcpHealth` observer; the key still sits under `mcpHealthKeys.all`, so
 * invalidating health reaches it too.
 */
export function useMcpSessions({ enabled }: { enabled: boolean }) {
  return useQuery({
    enabled,
    queryKey: [...mcpHealthKeys.all, "sessions"] as const,
    queryFn: async (): Promise<McpHealth> => {
      const res = await fetch("/api/mcp/health");
      return (await res.json()) as McpHealth;
    },
    refetchInterval: enabled ? 5000 : false,
  });
}
