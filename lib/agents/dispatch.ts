/**
 * Shared "hand a prompt to the libi agent" path.
 *
 * This is the canonical way for UI/server code to dispatch a NON-internal task
 * to the agent (e.g. "Approve generation" in the Script tab). It picks the
 * active or preferred agent, opens a fresh session, and fires the prompt.
 * When no agent is configured (bring-your-own-CLI), it throws
 * `NoAgentConfiguredError` so callers can fall back to copy-to-clipboard.
 *
 * `handOffToAgent` (lib/install-from-url) delegates here for its MCP-install
 * opener; the only difference is the message it builds.
 */
import { getSessionManager } from "@/lib/sessions/session-manager";
import { getSettings } from "@/lib/db/settings";
import { serverLogger as logger } from "@/lib/logger";
import { NoAgentConfiguredError } from "@/lib/agents/errors";

export type DispatchParams = {
  prompt: string;
  /** Override the auto-selected agent (defaults to active, then preferred). */
  agentId?: string;
};

/** Active → preferredAgent → throw NoAgentConfiguredError. */
export function pickAgentId(override?: string): string {
  if (override) return override;
  const sm = getSessionManager();
  if (sm.activeAgentId) return sm.activeAgentId;
  const settings = getSettings();
  if (settings.preferredAgent) return settings.preferredAgent;
  throw new NoAgentConfiguredError();
}

/** Send an arbitrary prompt to the libi agent in a fresh session. Throws
 *  `NoAgentConfiguredError` when no agent is available. */
export async function dispatchToAgent(
  params: DispatchParams,
): Promise<{ sessionId: string }> {
  const agentId = pickAgentId(params.agentId);
  const sm = getSessionManager();
  if (sm.activeAgentId !== agentId) {
    await sm.switchAgent(agentId);
  }
  const sessionId = await sm.createSession();
  // Fire-and-forget — the prompt runs async; errors are logged, not thrown
  // (same pattern as /api/agent/send).
  sm.sendMessage(sessionId, params.prompt).catch((err) => {
    logger.error(
      { tag: "agent-dispatch", op: "send_error", sessionId, err },
      "dispatch send failed",
    );
  });
  logger.info(
    { tag: "agent-dispatch", op: "dispatched", agentId, sessionId },
    "prompt dispatched to agent",
  );
  return { sessionId };
}
