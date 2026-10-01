/**
 * Shared "hand a prompt to the libi agent" path.
 *
 * This is the canonical way for UI/server code to dispatch a NON-internal task
 * to the agent (e.g. "Approve generation" in the Script tab). It picks the
 * active or preferred agent, opens a fresh session, and fires the prompt.
 * When no agent is configured (bring-your-own-CLI), it throws
 * `NoAgentConfiguredError` so callers can fall back to copy-to-clipboard.
 */
import { getSessionManager } from "@/lib/sessions/session-manager";
import { getSettings } from "@/lib/db/settings";
import { serverLogger as logger } from "@/lib/logger";
import {
  ApprovalModeHeldError,
  DispatchChatTakenError,
  NoAgentConfiguredError,
} from "@/lib/agents/errors";

export type DispatchParams = {
  prompt: string;
  /** Override the auto-selected agent (defaults to active, then preferred). */
  agentId?: string;
};

/**
 * The new chat of the last dispatch whose approval mode was held (retryably). The next dispatch to
 * the same agent retries in it while it is still untouched — no user message, still active —
 * instead of opening another empty chat the user never sees; its gate re-attempts the push, so it
 * is a real retry. Process-local and best-effort: losing it only means a fresh chat.
 */
let heldDispatchChat: { agentId: string; sessionId: string } | null = null;

/** Test-only: forget the held chat. */
export function resetHeldDispatchChatForTest(): void {
  heldDispatchChat = null;
}

function reusableHeldChat(agentId: string): string | null {
  const held = heldDispatchChat;
  if (!held || held.agentId !== agentId) return null;
  const sm = getSessionManager();
  const entry = sm.getSession(held.sessionId);
  if (
    !entry ||
    entry.agentId !== agentId ||
    !sm.hasActiveSession(held.sessionId) ||
    entry.userSent ||
    entry.messageCache.some((m) => m.role === "user")
  ) {
    heldDispatchChat = null;
    return null;
  }
  // Taken, so a concurrent dispatch opens its own chat; a hold again puts it back.
  heldDispatchChat = null;
  return held.sessionId;
}

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
 *  `NoAgentConfiguredError` when no agent is available, and `ApprovalModeHeldError` when the new
 *  chat's approval mode is held (Ask or Auto whose `set_mode` failed or never answered) — the prompt
 *  is then NOT sent, and the caller must say so rather than answer as if it went out. */
export async function dispatchToAgent(
  params: DispatchParams,
): Promise<{ sessionId: string }> {
  const agentId = pickAgentId(params.agentId);
  const sm = getSessionManager();
  if (sm.activeAgentId !== agentId) {
    await sm.switchAgent(agentId);
  }
  const reused = reusableHeldChat(agentId);
  const sessionId = reused ?? (await sm.createSession());
  // The same gate as /api/agent/send, before answering: `createSession` returns after its bounded
  // mode push, and `sendMessage` drops a held prompt silently (it returns void), so without this a
  // chat whose mode didn't land would get a note, no prompt, and a 200.
  const gate = await sm.awaitApprovalMode(sessionId);
  if (!gate.ok) {
    logger.warn(
      {
        tag: "agent-dispatch",
        op: "approval_mode_held",
        sessionId,
        mode: gate.mode,
        retryable: gate.retryable,
        reused: reused !== null,
      },
      "dispatched prompt held: the new chat's approval mode is not in force",
    );
    heldDispatchChat = gate.retryable ? { agentId, sessionId } : null;
    throw new ApprovalModeHeldError(gate, sessionId);
  }
  heldDispatchChat = null;
  // A retried chat is the user's the moment they write in it — also while this dispatch waited on
  // its gate. Then the prompt must not land in their chat.
  if (reused !== null && sm.getSession(sessionId)?.userSent) {
    logger.info(
      { tag: "agent-dispatch", op: "reused_chat_taken", agentId, sessionId },
      "the user wrote in the retried chat first; dispatch not sent",
    );
    throw new DispatchChatTakenError(sessionId);
  }
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
