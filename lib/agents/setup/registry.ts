import type { AgentSetup } from "./types";
import type { SetupAgentId } from "./commands";

/**
 * One declaration per agent. Sixteen places used to branch on a hardcoded
 * agent id, and the detection dispatcher was a two-way if/else — a third
 * agent added today would silently be treated as Codex. Adding an agent here
 * is a registry entry, not a hunt through call sites.
 *
 * `terminal` is deliberately absent: it is a pseudo-provider that short-
 * circuits before ACP is ever involved, so it has no sign-in flow to declare.
 */

// Each declaration's `id` is typed as `SetupAgentId`, not just `AgentSetup`'s
// plain `string` — so a new agent here that isn't also added to the
// `SetupAgentId` union (`commands.ts`) is a compile error, not a silently
// accepted id that `isSetupAgentId` would later trust.
const CLAUDE_CODE: AgentSetup & { id: SetupAgentId } = {
  id: "claude-code",
  name: "Claude Code",
  blurb: "Anthropic's coding agent. Best results with libi.",
  install: true,
  signIn: {
    displayCommand: "claude",
    envVar: "ANTHROPIC_API_KEY",
    // Observed on claude 2.1.245 and 2.1.267: session/new succeeds signed out.
    rejectedAt: "prompt",
  },
};

const CODEX: AgentSetup & { id: SetupAgentId } = {
  id: "codex",
  name: "Codex",
  blurb: "OpenAI's coding agent.",
  install: true,
  signIn: {
    displayCommand: "codex login",
    rejectedAt: "session-new",
  },
};

export const AGENT_SETUPS: readonly (AgentSetup & { id: SetupAgentId })[] = [CLAUDE_CODE, CODEX];

export function getAgentSetup(agentId: string): AgentSetup | null {
  return AGENT_SETUPS.find((a) => a.id === agentId) ?? null;
}

/** True for the agents the setup wizard walks through — the ones with a declaration here. */
export function isSetupAgentId(agentId: string): agentId is SetupAgentId {
  return getAgentSetup(agentId) !== null;
}

/**
 * The agents the setup surfaces offer — the setup wizard, and the Claude Code |
 * Codex switch on the Providers and Global setup tabs — in the order they list them.
 */
export const SETUP_AGENTS: readonly (AgentSetup & { id: SetupAgentId })[] = AGENT_SETUPS.filter(
  (a): a is AgentSetup & { id: SetupAgentId } => isSetupAgentId(a.id),
);

/** The name an agent is shown by. */
export function setupAgentName(agentId: SetupAgentId): string {
  return getAgentSetup(agentId)?.name ?? agentId;
}

export function listAgentSetups(): AgentSetup[] {
  return [...AGENT_SETUPS];
}

/**
 * Where a "not ready" surface sends the user: the Agents tab, opened on this
 * agent's setup when the wizard knows the agent, or on the tab itself for
 * anything else (no agent, `terminal`, an id nobody declared).
 */
export function agentSetupHref(agentId?: string | null): string {
  return agentId && isSetupAgentId(agentId)
    ? `/agents?tab=agents&agent=${agentId}`
    : "/agents?tab=agents";
}
