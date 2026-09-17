import type { AgentUnavailableReason } from "@/lib/agents/types";
import { getAgentSetup } from "@/lib/agents/setup/registry";
import type { SetupAgentId } from "@/lib/agents/setup/commands";
import type { ResolvedAgentCli } from "./resolve";

/**
 * Why the user's own CLI can't run an agent — the one bounded vocabulary the
 * agent selector, the start route, the boot warm and the process manager's
 * refused spawn all share. Null when the CLI is usable.
 *
 * A LEAF on purpose: it imports only the setup registry and types, so the
 * process manager can use it without the process-manager → agent-status →
 * session-manager → process-manager cycle.
 */
export function cliUnavailableReason(agentId: SetupAgentId, cli: ResolvedAgentCli): AgentUnavailableReason | null {
  const name = getAgentSetup(agentId)?.name ?? agentId;
  if (cli === null) return { code: "not_installed", message: `${name} isn't set up yet — open Agents to install it.` };
  if ("foundButBroken" in cli) {
    return { code: "install_failed", message: `${name} was found at ${cli.path} but won't run — open Agents.`, detail: "found but won't run" };
  }
  if (!cli.meetsMinimum) {
    return { code: "not_installed", message: `${name} ${cli.version} is older than libi needs — open Agents to update it.`, detail: "below minimum" };
  }
  return null;
}
