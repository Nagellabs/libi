/**
 * Hand-off path for `unknown` candidates and MCP-only repos.
 *
 * When the URL doesn't fit any of the three install shapes (no
 * `.claude-plugin/plugin.json`, no `SKILL.md`), we delegate to the
 * agent: spin up a new chat session, post a directive opener message
 * telling the agent to read the repo's README and call
 * `libi.register_mcp_server`.
 */

import { dispatchToAgent } from "@/lib/agents/dispatch";

export type HandoffParams = {
  url: string;
  /** Override the auto-selected agent (defaults to active or preferredAgent). */
  agentId?: string;
};

/**
 * The opener message we paste into the new chat. The exact wording is
 * deliberate — it names the tools the agent should use so the model
 * doesn't have to guess.
 */
function buildOpenerMessage(url: string): string {
  return [
    `Install the MCP server from ${url}. Read the repository's README, run any install commands needed (npm install / pip install / uv sync), then call \`libi.register_mcp_server\` with the correct command, args, and env vars.`,
    ``,
    `If it requires secret values (API keys, tokens), ask me for them before completing the registration.`,
    ``,
    `After registration, confirm by calling \`libi.list_mcp_servers\` and verify the new server appears.`,
  ].join("\n");
}

/**
 * Build the MCP-install opener and dispatch it to the agent in a fresh
 * session (via the shared `dispatchToAgent`). Returns the new sessionId so
 * the API route can navigate the UI to it. Throws `NoAgentConfiguredError`
 * (re-exported from ./types) when no agent is configured.
 */
export async function handOffToAgent(
  params: HandoffParams,
): Promise<{ sessionId: string }> {
  return dispatchToAgent({
    prompt: buildOpenerMessage(params.url),
    agentId: params.agentId,
  });
}
