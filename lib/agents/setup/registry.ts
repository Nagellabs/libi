import type { AgentSetup } from "./types";

/**
 * One declaration per agent. Sixteen places used to branch on a hardcoded
 * agent id, and the detection dispatcher was a two-way if/else — a third
 * agent added today would silently be treated as Codex. Adding an agent here
 * is a registry entry, not a hunt through call sites.
 *
 * `terminal` is deliberately absent: it is a pseudo-provider that short-
 * circuits before ACP is ever involved, so it has no sign-in flow to declare.
 */

const CLAUDE_CODE: AgentSetup = {
  id: "claude-code",
  name: "Claude Code",
  blurb: "Anthropic's coding agent. Best results with libi.",
  install: {
    command: "npm i -g @anthropic-ai/claude-code",
    sizeLabel: "about 345 MB",
    manual: [
      { text: "Open any terminal — libi's built-in one, or your own — and run {cmd}.", command: "npm i -g @anthropic-ai/claude-code" },
      { text: "npm downloads Claude Code and its engine. It is a large download and only happens once." },
      { text: "Come back to libi and press Retry. Claude Code appears as soon as libi can see it." },
    ],
  },
  signIn: {
    displayCommand: "claude",
    envVar: "ANTHROPIC_API_KEY",
    manual: [
      { text: "Open any terminal — libi's built-in one, or your own — and run {cmd}.", command: "claude" },
      { text: "Pick how you want to sign in: your Claude subscription, or an Anthropic API key. Claude Code opens your browser to finish." },
      { text: "Signing in happens once, in the terminal. Come back to libi, pick it again in the agent selector, and you chat with it inside libi from then on." },
    ],
  },
};

const CODEX: AgentSetup = {
  id: "codex",
  name: "Codex",
  blurb: "OpenAI's coding agent. Included with libi — nothing to install.",
  install: null,
  signIn: {
    displayCommand: "codex login",
    manual: [
      { text: "Open any terminal — libi's built-in one, or your own — and run {cmd}.", command: "codex login" },
      { text: "Pick how you want to sign in: your ChatGPT account, or an OpenAI API key. Codex opens your browser to finish." },
      { text: "Signing in happens once, in the terminal. Come back to libi, pick it again in the agent selector, and you chat with it inside libi from then on." },
    ],
  },
};

export const AGENT_SETUPS: readonly AgentSetup[] = [CLAUDE_CODE, CODEX];

export function getAgentSetup(agentId: string): AgentSetup | null {
  return AGENT_SETUPS.find((a) => a.id === agentId) ?? null;
}

export function listAgentSetups(): AgentSetup[] {
  return [...AGENT_SETUPS];
}
