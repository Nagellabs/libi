import { getSettings, updateSettings } from "@/lib/db/settings";

/**
 * Per-agent saved model preference (agentId → modelId), persisted in the
 * settings DB. Mirrors `lib/approval/settings.ts` — ACP adapters (e.g.
 * claude-agent-acp 0.44) apply a model switch only to the active session and
 * do NOT persist it as a default for new sessions, so libi remembers the
 * choice here and re-applies it on every new/standby/resumed session
 * (see `SessionManager.pushModelToSession`).
 */
export type ModelPreferenceMap = Record<string, string>;

function read(): ModelPreferenceMap {
  const raw = getSettings().agentModelPreferences;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: ModelPreferenceMap = {};
    for (const [agentId, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value) out[agentId] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** The saved model id for an agent, or null if the user never picked one. */
export function getAgentModelId(agentId: string): string | null {
  return read()[agentId] ?? null;
}

/** Persist the user's model choice for an agent. */
export function setAgentModelId(agentId: string, modelId: string): void {
  const current = read();
  current[agentId] = modelId;
  updateSettings({ agentModelPreferences: JSON.stringify(current) });
}
