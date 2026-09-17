/**
 * Packages installed into ~/.libi/agents/node_modules at runtime rather than
 * bundled into the artifact.
 *
 * NB the path: `~/.libi/agents/` (this npm root) is NOT `~/.libi/node_modules/`
 * (the bundled-MCP root) and NOT `~/.libi/agent/` (the agent workspace, one
 * letter apart). Anyone diagnosing a missing adapter must look under
 * `~/.libi/agents/node_modules/`.
 *
 * The Claude ACP adapter transitively pulls @anthropic-ai/claude-agent-sdk,
 * which is "© Anthropic PBC. All rights reserved." libi is GPL-3.0 and holds
 * no licence to redistribute it, so the user installs it from npm —
 * Anthropic's own channel — under their own terms.
 *
 * Only the adapters' JavaScript is installed (`npm install --omit=optional`):
 * the chat runs the user's own CLI, so the engines the adapters list as
 * optionalDependencies are never downloaded.
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
  /** The `CliAgentConfig.id` this adapter serves — `lib/agents/setup/registry.ts`. */
  readonly agentId: "claude-code" | "codex";
  readonly npmPackage: string;
  readonly pinnedVersion: string;
  /** Executable base name under ~/.libi/agents/node_modules/.bin/ (`.cmd` on win32) */
  readonly binName: string;
  /** Bytes a cold download of this package lands on disk, for the progress
   *  bar's denominator ONLY — the adapter's JS tree as a real
   *  `npm install --omit=optional` lands it (no engine). Lives
   *  here, next to the package, so a third agent cannot be registered without
   *  one and silently inherit another agent's bar. Kept separate from the
   *  download size the user reads (`adapter-copy.ts`): that is UI copy, and
   *  coupling them would let an unrelated wording edit change the denominator. */
  readonly estimatedInstallBytes: number;
}

export const CLAUDE_ADAPTER_PACKAGE: RuntimeAgentPackage = {
  agentId: "claude-code",
  npmPackage: "@agentclientprotocol/claude-agent-acp",
  pinnedVersion: "0.75.1",
  binName: "claude-agent-acp",
  // The adapter's JS tree without its engine, measured from a real
  // `npm install --omit=optional` of this pin.
  estimatedInstallBytes: 56_258_560,
};

/**
 * Codex's adapter left `dependencies` for the same reason as Claude's, minus
 * the licence: `@openai/codex-<platform>-<arch>` is a ~258 MB Rust binary that
 * every `npx libi` install and every packaged `.app` carried whether or not the
 * user ever chose Codex. It is Apache-2.0, so bundling was LEGAL — it was just
 * a fifth of the artifact spent on an agent half the users do not pick.
 *
 * Kept as a devDependency (not deleted) so `npm run dev` still resolves it from
 * the repo's own `node_modules/.bin` and stays offline-capable — the same
 * short-circuit `resolveRepoLocalAdapterBin` gives the Claude adapter.
 */
export const CODEX_ADAPTER_PACKAGE: RuntimeAgentPackage = {
  agentId: "codex",
  npmPackage: "@agentclientprotocol/codex-acp",
  pinnedVersion: "1.10.0",
  binName: "codex-acp",
  // The adapter's JS tree without its engine (@openai/codex-<platform>-<arch>),
  // measured from a real `npm install --omit=optional` of this pin.
  estimatedInstallBytes: 17_428_480,
};

export const RUNTIME_AGENT_PACKAGES: readonly RuntimeAgentPackage[] = [
  CLAUDE_ADAPTER_PACKAGE,
  CODEX_ADAPTER_PACKAGE,
];

/** The adapter package an agent id needs, or null for ids libi does not install
 *  (`terminal`, and anything unknown). */
export function runtimeAgentPackage(agentId: string): RuntimeAgentPackage | null {
  return RUNTIME_AGENT_PACKAGES.find((p) => p.agentId === agentId) ?? null;
}
