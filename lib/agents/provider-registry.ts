import { detectInstalledAgents } from "./acp/agent-registry";
import type { AgentProviderInfo } from "./types";

export function getProviderInfos(): AgentProviderInfo[] {
  const agents = detectInstalledAgents();
  return agents.map((a) => ({
    id: a.id,
    name: a.name,
    type: "acp" as const,
    available: a.installed,
    requiresApiKey: false,
    apiKeyConfigured: true,
    capabilities: { canListSessions: false },
    // Carried through so the selector can render a DISABLED row explaining
    // why (e.g. "installing now") instead of dropping the agent silently.
    ...(a.installed ? {} : { unavailableReason: a.unavailableReason }),
  }));
}
