import { trackEvent } from "@/lib/analytics/client";
import type { AgentStatus } from "@/lib/agents/agent-status";
import type { SetupAgentId, SetupCli } from "@/lib/agents/setup/commands";

export type WizardStepName = "choose" | "install" | "sign-in" | "connect" | "open-chat";

export function cliMeetsMinimum(cli: AgentStatus["cli"]): boolean {
  return cli !== null && "meetsMinimum" in cli && cli.meetsMinimum;
}

/** The CLI a printed command runs — its resolved realpath. `null` when nothing runnable was found. */
export function setupCliFor(agent: SetupAgentId, cli: AgentStatus["cli"]): SetupCli | null {
  return cli !== null && "realPath" in cli ? { agentId: agent, realPath: cli.realPath } : null;
}

/** Counted on a step's success path only, never on a click alone. */
export function reportStepCompleted(agent: SetupAgentId, step: WizardStepName): void {
  trackEvent("agent_wizard_step_completed", { agent, step });
}
