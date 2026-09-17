import { resolveAgentCli, type ResolvedAgentCli } from "@/lib/agents/cli/resolve";
import { detectLibiRegistration, type LibiRegistrations, type LibiToolsState } from "@/lib/agents/libi-registration";
import { getSignInConfirmedAt } from "@/lib/agents/sign-in-confirmation";
import { getAgentConfig } from "@/lib/agents/acp/agent-registry";
import { getSessionManager } from "@/lib/sessions/session-manager";
import type { SetupAgentId } from "@/lib/agents/setup/commands";

export { cliUnavailableReason } from "./cli/unavailable-reason";

/** libi's adapter for the agent: installed, being installed, failed to install, or absent. */
export type AdapterState = "ready" | "installing" | "failed" | "missing";

/**
 * One agent's setup state — the single answer the Agents tab, its status bar and
 * the setup wizard all read (`GET /api/agents/status`).
 */
export interface AgentStatus {
  agentId: SetupAgentId;
  /** `realPath` is what every printed command uses; `execPath` stays server-side. */
  cli: { path: string; realPath: string; version: string; meetsMinimum: boolean } | { foundButBroken: true; path: string } | null;
  adapter: AdapterState;
  /** `needsAuth` is an OBSERVED auth rejection — it outranks a stored `confirmedAt`. */
  signIn: { confirmedAt: string | null; needsAuth: boolean };
  /** `scope` is reported for Claude only — its disconnect command has to name it. */
  libiTools: { state: LibiToolsState; scope?: "user" | "local"; stale?: true };
  /** A usable CLI at or above the minimum version, and an installed adapter. */
  ready: boolean;
}

export function adapterStateFrom(config: { installed: boolean; unavailableReason?: { code: string } } | undefined): AdapterState {
  if (!config) return "missing";
  if (config.installed) return "ready";
  switch (config.unavailableReason?.code) {
    case "installing":
      return "installing";
    case "install_failed":
      return "failed";
    default:
      return "missing";
  }
}

export interface AgentStatusDeps {
  resolveCli?: () => Promise<ResolvedAgentCli>;
  adapterConfig?: () => { installed: boolean; unavailableReason?: { code: string } } | undefined;
  signInConfirmedAt?: () => Date | null;
  readinessState?: () => string;
  libiRegistration?: (agentId: SetupAgentId) => Promise<LibiRegistrations>;
  /**
   * "Check again": ask codex's registration afresh, dropping only its own answer memo. Unlike a
   * plain Retry, a listing already running from before this call is not trusted as this call's
   * answer — the user may just have run their own `codex mcp add`. Passed through to
   * `detectLibiRegistration`'s own `refresh` AND `checkAgain` when `libiRegistration` is not
   * injected (this is the only caller of `buildAgentStatus` that ever sets it).
   */
  refresh?: boolean;
}

export async function buildAgentStatus(agentId: SetupAgentId, deps: AgentStatusDeps = {}): Promise<AgentStatus> {
  const resolved = await (deps.resolveCli ?? (() => resolveAgentCli(agentId)))();
  const cli: AgentStatus["cli"] =
    resolved === null
      ? null
      : "foundButBroken" in resolved
        ? { foundButBroken: true, path: resolved.path }
        : { path: resolved.path, realPath: resolved.realPath, version: resolved.version, meetsMinimum: resolved.meetsMinimum };
  const adapter = adapterStateFrom((deps.adapterConfig ?? (() => getAgentConfig(agentId)))());
  const confirmedAt = (deps.signInConfirmedAt ?? (() => getSignInConfirmedAt(agentId)))();
  const readiness = (deps.readinessState ?? (() => getSessionManager().getReadiness(agentId).state))();
  // No usable CLI → nothing to read a registration through, so report not-connected
  // without reading any config. Detection is asked for THIS agent only: the other
  // agent's entry in its answer is a placeholder, never real state.
  const readRegistration =
    deps.libiRegistration ??
    ((id: SetupAgentId) => detectLibiRegistration({ only: id, refresh: deps.refresh, checkAgain: deps.refresh }));
  const reg = cli && "meetsMinimum" in cli ? (await readRegistration(agentId))[agentId] : { state: "not-connected" as const };
  const libiTools: AgentStatus["libiTools"] = {
    state: reg.state,
    ...(agentId === "claude-code" && reg.scope ? { scope: reg.scope } : {}),
    ...(reg.stale ? { stale: true as const } : {}),
  };
  return {
    agentId,
    cli,
    adapter,
    signIn: { confirmedAt: confirmedAt ? confirmedAt.toISOString() : null, needsAuth: readiness === "needs-auth" },
    libiTools,
    ready: cli !== null && "meetsMinimum" in cli && cli.meetsMinimum && adapter === "ready",
  };
}
