import type { AgentStatus } from "@/lib/agents/agent-status";
import type { SetupAgentId } from "@/lib/agents/setup/commands";
import { SETUP_AGENTS, setupAgentName } from "@/lib/agents/setup/registry";

export type WizardStep = 1 | 2 | 3 | 4;

/** The agents the wizard offers, in order, with their names: the setup registry's list. */
export const WIZARD_AGENTS = SETUP_AGENTS;

export const wizardAgentName: (agent: SetupAgentId) => string = setupAgentName;

export const WIZARD_STEP_TITLES: Record<WizardStep, string> = {
  1: "Choose an agent",
  2: "Install",
  3: "Sign in",
  4: "Open chat",
};

function cliUsable(cli: AgentStatus["cli"]): boolean {
  return cli !== null && "meetsMinimum" in cli && cli.meetsMinimum;
}

/**
 * The step the wizard opens at for an agent: the first one not yet done. Never
 * step 1 — the agent is already chosen by the time there is a status to read.
 */
export function firstIncompleteStep(status: AgentStatus): WizardStep {
  // The adapter install starts only from step 2, and a chat cannot start without
  // it (`/api/agent/start` refuses an agent whose adapter is not installed) — so
  // step 2 stays incomplete until the CLI is usable AND the adapter is ready.
  if (!cliUsable(status.cli) || status.adapter !== "ready") return 2;
  if (status.signIn.needsAuth || status.signIn.confirmedAt === null) return 3;
  return 4;
}

export function installedLabel(cli: AgentStatus["cli"]): string {
  if (cli === null) return "not found";
  // Beside the install step's "is on your PATH but won't run" — never "found", which reads as fine.
  if ("foundButBroken" in cli) return "won't run";
  return cli.meetsMinimum ? cli.version : `update needed (${cli.version})`;
}

/** An observed auth rejection outranks a stored confirmation. */
export function signedInLabel(s: AgentStatus["signIn"]): "Needs sign-in" | "Confirmed" | "Not confirmed" {
  if (s.needsAuth) return "Needs sign-in";
  return s.confirmedAt ? "Confirmed" : "Not confirmed";
}

export type StatusTone = "good" | "warn" | "bad" | "neutral";

export function installedTone(cli: AgentStatus["cli"]): StatusTone {
  if (cli === null) return "neutral";
  if ("foundButBroken" in cli) return "bad";
  return cli.meetsMinimum ? "good" : "warn";
}

export function signedInTone(s: AgentStatus["signIn"]): StatusTone {
  if (s.needsAuth) return "warn";
  return s.confirmedAt ? "good" : "neutral";
}

export const TONE_DOT: Record<StatusTone, string> = {
  good: "bg-emerald-500",
  warn: "bg-amber-400",
  bad: "bg-destructive",
  neutral: "bg-muted-foreground/40",
};
