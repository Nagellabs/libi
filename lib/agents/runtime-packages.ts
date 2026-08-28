/**
 * Packages installed into ~/.libi/agents/node_modules at runtime rather than
 * bundled into the artifact.
 *
 * NB the path: `~/.libi/agents/` (this npm root) is NOT `~/.libi/node_modules/`
 * (the bundled-MCP root) and NOT `~/.libi/agent/` (the agent workspace, one
 * letter apart). Anyone diagnosing a missing adapter must look under
 * `~/.libi/agents/node_modules/`.
 *
 * The Claude ACP adapter transitively pulls @anthropic-ai/claude-agent-sdk
 * (+ its ~306MB platform binary), which is "© Anthropic PBC. All rights
 * reserved." libi is GPL-3.0 and holds no licence to redistribute it, so the
 * user installs it from npm — Anthropic's own channel — under their own terms.
 *
 * These install into their OWN npm root (`~/.libi/agents`), never the
 * bundled-MCP root — see lib/agents/runtime-install.ts for why.
 *
 * Leaf module (no imports) so it can be read from anywhere without a cycle.
 *
 * Keep pinnedVersion in lockstep with package.json's devDependency on the
 * same package so dev and production run identical adapter code. It is a
 * devDependency (not a dependency) so `npx libi` never installs it — see
 * lib/agents/runtime-install.ts for the full resolution order.
 */
export interface RuntimeAgentPackage {
  readonly npmPackage: string;
  readonly pinnedVersion: string;
  /** Executable base name under ~/.libi/agents/node_modules/.bin/ (`.cmd` on win32) */
  readonly binName: string;
}

export const CLAUDE_ADAPTER_PACKAGE: RuntimeAgentPackage = {
  npmPackage: "@agentclientprotocol/claude-agent-acp",
  pinnedVersion: "0.70.0",
  binName: "claude-agent-acp",
};

export const RUNTIME_AGENT_PACKAGES: readonly RuntimeAgentPackage[] = [CLAUDE_ADAPTER_PACKAGE];
