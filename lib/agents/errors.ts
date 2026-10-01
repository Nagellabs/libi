import type { ApprovalGate } from "@/lib/sessions/session-manager";

/**
 * Shared agent errors.
 *
 * `NoAgentConfiguredError` is thrown by server actions that need a libi agent
 * but find none active/preferred (bring-your-own-CLI mode). Callers MUST map
 * this to a friendly, non-error UX (e.g. "copy the prompt into your CLI"),
 * never a hard failure.
 */
export class NoAgentConfiguredError extends Error {
  constructor(
    message = "No agent is configured. Select an agent in the sidebar, or copy the prompt into your own CLI.",
  ) {
    super(message);
    this.name = "NoAgentConfiguredError";
  }
}

/**
 * A prompt dispatched to a NEW chat (`dispatchToAgent`) that the chat's approval-mode gate held:
 * under "Ask each time" or "Auto", its mode push failed or never answered, and sending would let
 * tools run in the agent's own mode with no card. The chat exists (with its note); the prompt was
 * not sent. `POST /api/agent/dispatch` answers 503 naming the mode and the chat.
 */
export class ApprovalModeHeldError extends Error {
  constructor(
    readonly gate: Extract<ApprovalGate, { ok: false }>,
    readonly sessionId: string,
  ) {
    super(gate.error);
    this.name = "ApprovalModeHeldError";
  }
}

/**
 * `dispatchToAgent` retried in the chat a held dispatch left, but the user wrote in that chat while
 * the dispatch waited on its gate: the chat is theirs now, so the prompt was not sent into it.
 * `POST /api/agent/dispatch` answers 503 with the reason and the chat.
 */
export class DispatchChatTakenError extends Error {
  constructor(readonly sessionId: string) {
    super(
      "You started writing in the chat libi was about to use, so the prompt wasn't sent — send it again to open a new chat.",
    );
    this.name = "DispatchChatTakenError";
  }
}
