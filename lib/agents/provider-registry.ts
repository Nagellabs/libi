import { detectInstalledAgents } from "./acp/agent-registry";
import { resolveAgentCli } from "./cli/resolve";
import { cliUnavailableReason } from "./cli/unavailable-reason";
import { isSetupAgentId } from "./setup/registry";
import type { AgentProviderInfo } from "./types";

/**
 * available = the adapter is installed AND the user's own CLI resolves and meets
 * the minimum version. Async because the CLI memo may be cold. An unavailable
 * provider always carries its reason, so the selector renders a DISABLED row
 * explaining why instead of dropping the agent silently: the adapter's reason
 * when the adapter is missing, otherwise the CLI's (which points at Agents).
 */
export async function getProviderInfos(): Promise<AgentProviderInfo[]> {
  // Both agents resolve at once: a cold memo costs one login-shell probe per
  // agent, and they share nothing. No `staleOk` here — the selector should show
  // what is true now, not an expired memo.
  return Promise.all(
    detectInstalledAgents().map(async (a): Promise<AgentProviderInfo> => {
      const cliReason =
        a.installed && isSetupAgentId(a.id) ? cliUnavailableReason(a.id, await resolveAgentCli(a.id)) : null;
      const available = a.installed && cliReason === null;
      const unavailableReason = a.installed ? cliReason : a.unavailableReason;
      return {
        id: a.id,
        name: a.name,
        type: "acp" as const,
        available,
        requiresApiKey: false,
        apiKeyConfigured: true,
        capabilities: { canListSessions: false },
        ...(!available && unavailableReason ? { unavailableReason } : {}),
      };
    }),
  );
}
