"use client";

import { useAgentHandoffFollow } from "@/hooks/agent/use-agent-handoff-follow";

/**
 * Mount-point for the layout-level hand-off follower (see
 * lib/agents/agent-handoff.ts). Returns null — like GlobalRefreshMount, it
 * exists so the server-component layout can run a client hook.
 */
export function AgentHandoffMount() {
  useAgentHandoffFollow();
  return null;
}
