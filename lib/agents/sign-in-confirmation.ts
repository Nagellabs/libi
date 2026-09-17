import { getSettings, updateSettings } from "@/lib/db/settings";
import type { SetupAgentId } from "@/lib/agents/setup/commands";

const COLUMN: Record<SetupAgentId, "claudeSignInConfirmedAt" | "codexSignInConfirmedAt"> = {
  "claude-code": "claudeSignInConfirmedAt",
  codex: "codexSignInConfirmedAt",
};

/**
 * The one persisted setup-wizard value: the user said they are signed in to
 * this agent. libi cannot detect sign-in, so this is a UI gate only. Read live,
 * never cached.
 */
export function getSignInConfirmedAt(agentId: SetupAgentId): Date | null {
  return getSettings()[COLUMN[agentId]];
}

export function setSignInConfirmed(agentId: SetupAgentId, at: Date = new Date()): Date {
  updateSettings({ [COLUMN[agentId]]: at });
  return at;
}

/** Called from the session manager on an OBSERVED auth rejection — the only clearer. */
export function clearSignInConfirmation(agentId: SetupAgentId): void {
  updateSettings({ [COLUMN[agentId]]: null });
}
