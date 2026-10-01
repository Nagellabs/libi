import { trackEvent } from "@/lib/analytics/client";
import type { AgentStatus } from "@/lib/agents/agent-status";
import type { SetupAgentId, SetupCli } from "@/lib/agents/setup/commands";

export type WizardStepName = "choose" | "install" | "sign-in" | "connect" | "open-chat";

export function cliMeetsMinimum(cli: AgentStatus["cli"]): boolean {
  return cli !== null && "meetsMinimum" in cli && cli.meetsMinimum;
}

/** The CLI a printed command runs — its resolved realpath (and, on Windows, a `.cmd` shim's own target). `null` when
 *  nothing runnable was found. */
export function setupCliFor(agent: SetupAgentId, cli: AgentStatus["cli"]): SetupCli | null {
  if (cli === null || !("realPath" in cli)) return null;
  return { agentId: agent, realPath: cli.realPath, ...(cli.launch ? { launch: cli.launch } : {}) };
}

/** Counted on a step's success path only, never on a click alone. */
export function reportStepCompleted(agent: SetupAgentId, step: WizardStepName): void {
  trackEvent("agent_wizard_step_completed", { agent, step });
}
