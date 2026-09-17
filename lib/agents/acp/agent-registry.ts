import { serverLogger as logger } from "@/lib/logger";
import {
  adapterUnavailableReason,
  getAgentInstallRoot,
  resolveClaudeAdapterBin,
  resolveInstalledAdapterBin,
  resolveRepoLocalAdapterBin,
} from "@/lib/agents/runtime-install";
import { CLAUDE_ADAPTER_PACKAGE, CODEX_ADAPTER_PACKAGE } from "@/lib/agents/runtime-packages";
import type { AgentUnavailableReason } from "@/lib/agents/types";
import { spawnViaNodeIfScript, type ResolvedBin } from "@/lib/agents/cli/spawn-shape";

// Moved to `lib/agents/cli/spawn-shape.ts`; re-exported so existing importers keep working.
export { spawnViaNodeIfScript, resolveCmdShimTarget } from "@/lib/agents/cli/spawn-shape";

export interface CliAgentConfig {
  id: string;
  name: string;
  /** Command to spawn for ACP communication */
  command: string;
  /** Args for the ACP spawn command */
  args: string[];
  /**
   * The CLI name `resolveAgentCli` (`lib/agents/cli/resolve.ts`) looks for.
   * Detection here never probes it; `GET /api/agents/status` reports it.
   */
  detectCommand: string;
  envHints: string[];
  installed: boolean;
  /** Set only when `installed` is false — why, for a disabled selector row. */
  unavailableReason?: AgentUnavailableReason;
}

/** A resolved Claude adapter bin plus the npm tree root it belongs to. */
type ClaudeBinResolution = { bin: ResolvedBin; root: string };

/**
 * A resolved codex-acp bin plus the npm tree root it belongs to — both null
 * when the adapter is not on disk anywhere yet (see `resolveCodexBin`).
 */
type CodexBinResolution = { bin: ResolvedBin | null; root: string | null };

/**
 * Resolve the Codex ACP adapter bin: repo-local checkout first, then the
 * runtime-installed copy under `~/.libi/agents` — the SAME order and the same
 * two candidates `resolveClaudeBin` uses.
 *
 * The old `npx -y @agentclientprotocol/codex-acp` fallback is gone with the
 * production dependency it backed. It was already never reported as installed
 * (`detectCodex` returns `not_installed` for a null root), and in a packaged
 * app it would be an unpinned network fetch of an arbitrary version — the exact
 * thing `resolveClaudeBin` refuses. Now that the adapter is downloaded on
 * selection, "not on disk" means "not installed yet", which is a state the UI
 * can act on, not a broken install.
 *
 * The `.bin/codex-acp` shim is a `#!/usr/bin/env node` script, so it goes
 * through `spawnViaNodeIfScript` for the same reason the Claude adapter does:
 * a Finder-launched packaged app has no `node` on its launchd PATH.
 */
function resolveCodexBin(): CodexBinResolution {
  const repoRoot = process.cwd();
  const repoLocal = resolveRepoLocalAdapterBin(repoRoot, CODEX_ADAPTER_PACKAGE);
  const binPath = repoLocal ?? resolveInstalledAdapterBin(CODEX_ADAPTER_PACKAGE);
  if (!binPath) {
    // Same copy and rule as `resolveClaudeBin` below.
    const reason = adapterUnavailableReason(null, CODEX_ADAPTER_PACKAGE);
    logger.warn({ tag: "agent-registry", op: "codex_adapter_unresolved", code: reason.code }, reason.message);
    return { bin: null, root: null };
  }
  // The tree the bin came from: the checkout in dev, ~/.libi/agents otherwise.
  const root = binPath === repoLocal ? repoRoot : getAgentInstallRoot();
  return { bin: spawnViaNodeIfScript(binPath), root };
}

/**
 * Resolve the Claude ACP adapter bin: repo-local checkout first, then the
 * runtime-installed copy under `~/.libi/agents` (see
 * `lib/agents/runtime-install.ts#resolveClaudeAdapterBin`). Like
 * `resolveCodexBin` above, this NEVER falls back to npx — the adapter transitively
 * pulls `@anthropic-ai/claude-agent-sdk` (+ its ~306MB platform binary),
 * which libi holds no licence to redistribute and is therefore installed at
 * runtime from npm, not bundled. An unpinned `npx claude-agent-acp` in a
 * packaged app would silently fetch an arbitrary version over the network —
 * slow, unreproducible, and broken offline. Returns null when the adapter
 * isn't available anywhere yet; the caller surfaces `installed: false`
 * instead of spawning anything.
 */
function resolveClaudeBin(): ClaudeBinResolution | null {
  const repoRoot = process.cwd();
  const repoLocal = resolveRepoLocalAdapterBin(repoRoot);
  const binPath = resolveClaudeAdapterBin({
    repoLocal,
    installed: resolveInstalledAdapterBin(),
  });
  if (!binPath) {
    // The reason the disabled Agents row shows, so the log never claims an
    // install nobody started: "installing" only while an install holds the
    // agent-root lock, otherwise not set up (or failed), pointing at Agents.
    // This used to say "still installing" unconditionally, including on a
    // fresh home before any install job existed.
    const reason = adapterUnavailableReason(null, CLAUDE_ADAPTER_PACKAGE);
    logger.warn({ tag: "agent-registry", op: "claude_adapter_unresolved", code: reason.code }, reason.message);
    return null;
  }
  // The tree the bin came from: the checkout in dev, ~/.libi/agents otherwise.
  const root = binPath === repoLocal ? repoRoot : getAgentInstallRoot();
  return { bin: spawnViaNodeIfScript(binPath), root };
}

type Bins = { "claude-agent-acp": ClaudeBinResolution | null; "codex-acp": CodexBinResolution };

/** Lazily resolved binary paths — deferred so filesystem access doesn't run at import time. */
let resolvedBins: Bins | null = null;

function getBins(): Bins {
  if (!resolvedBins) {
    resolvedBins = {
      "claude-agent-acp": resolveClaudeBin(),
      "codex-acp": resolveCodexBin(),
    };
  }
  return resolvedBins;
}

/**
 * One entry per known agent, carrying its OWN detection dispatch alongside
 * its static fields. `runDetection` below used to be a two-way
 * `if (agent.id === "claude-code") ... else ...` — meaning a third agent
 * added to the array here would silently run Codex's probe against it. Each
 * entry now says how to detect itself, so adding an agent can't leave this
 * fork out of date.
 */
type KnownAgent = Omit<CliAgentConfig, "installed"> & {
  /** How this agent decides it is usable — `detectClaudeCode` / `detectCodex`,
   *  unchanged in behaviour, just no longer chosen by an id comparison. */
  detect: (agent: Omit<CliAgentConfig, "installed">, root: string | null) => CliAgentConfig;
  /** How its npm-tree root is found, for the `detect` call above. */
  resolveRoot: () => string | null;
};

function getKnownAgents(): KnownAgent[] {
  const bins = getBins();
  const claudeBin = bins["claude-agent-acp"]?.bin ?? null;
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      // Empty when the adapter couldn't be resolved anywhere — detectClaudeCode
      // below treats that as authoritative, so this never spawns with an empty
      // command.
      command: claudeBin?.command ?? "",
      args: claudeBin?.args ?? [],
      detectCommand: "claude",
      envHints: ["ANTHROPIC_API_KEY"],
      detect: detectClaudeCode,
      resolveRoot: () => bins["claude-agent-acp"]?.root ?? null,
    },
    {
      id: "codex",
      name: "Codex",
      // Empty when the adapter isn't on disk anywhere yet — detectCodex below
      // treats that as authoritative, exactly like claude-code above.
      command: bins["codex-acp"].bin?.command ?? "",
      args: bins["codex-acp"].bin?.args ?? [],
      detectCommand: "codex",
      envHints: ["OPENAI_API_KEY"],
      detect: detectCodex,
      resolveRoot: () => bins["codex-acp"].root,
    },
  ];
}

/**
 * The ids this detection table dispatches on.
 *
 * Exists so a test can assert the two agent registries agree without merging
 * them: `lib/agents/setup/registry.ts` (pure, browser-safe — what to SAY) and
 * this table (what to DETECT). The split is deliberate and stays; what was
 * missing was anything asserting an id declared in one exists in the other. A setup
 * entry with no detection entry is an agent the app offers to install and can
 * never see.
 */
export function knownAgentIds(): string[] {
  return getKnownAgents().map((a) => a.id);
}

let cachedAgents: CliAgentConfig[] | null = null;

/**
 * Claude Code "installed" = its ACP adapter is on disk (the checkout in dev,
 * ~/.libi/agents otherwise). The CLI the adapter drives is the user's own
 * `claude`, resolved separately by `resolveAgentCli` and combined with this in
 * `provider-registry.ts` and the process manager. Nothing here reads PATH.
 */
function detectClaudeCode(
  agent: Omit<CliAgentConfig, "installed">,
  claudeRoot: string | null,
): CliAgentConfig {
  // No adapter bin anywhere: there is nothing to spawn (and a packaged app must
  // never fall back to `npx`), so it can't be reported installed on any other evidence.
  if (!agent.command || !claudeRoot) {
    return {
      ...agent,
      installed: false,
      unavailableReason: adapterUnavailableReason(null, CLAUDE_ADAPTER_PACKAGE),
    };
  }
  return { ...agent, installed: true };
}

/**
 * Codex "installed" = its ACP adapter is on disk (the checkout in dev,
 * ~/.libi/agents otherwise). The CLI the adapter drives is the user's own
 * `codex`, resolved separately by `resolveAgentCli` and combined with this in
 * `provider-registry.ts` and the process manager. Nothing here reads PATH.
 */
function detectCodex(
  agent: Omit<CliAgentConfig, "installed">,
  codexRoot: string | null,
): CliAgentConfig {
  // No adapter bin anywhere: "not installed yet", a state the Agents tab can act on.
  if (!agent.command || !codexRoot) {
    return {
      ...agent,
      installed: false,
      unavailableReason: adapterUnavailableReason(null, CODEX_ADAPTER_PACKAGE),
    };
  }
  return { ...agent, installed: true };
}

function runDetection(): CliAgentConfig[] {
  // Destructure `detect`/`resolveRoot` off before handing `agent` to its own
  // `detect` — otherwise the spread inside detectClaudeCode/detectCodex
  // (`{ ...agent, installed: … }`) would carry those two functions into the
  // CliAgentConfig this returns.
  return getKnownAgents().map(({ detect, resolveRoot, ...agent }) => detect(agent, resolveRoot()));
}

/** Returns cached agent detection results. Always instant after warmup. */
export function detectInstalledAgents(): CliAgentConfig[] {
  if (cachedAgents) return cachedAgents;
  cachedAgents = runDetection();
  return cachedAgents;
}

/** Get the config for a specific agent by ID */
export function getAgentConfig(
  agentId: string
): CliAgentConfig | undefined {
  return detectInstalledAgents().find((a) => a.id === agentId);
}

/**
 * Re-detect agents — called whenever the Agents page reads agent status, and
 * after an agent install finishes.
 *
 * Also clears the resolved-bin cache: either adapter can finish its runtime
 * install (the `agent_install` job, `lib/jobs/runners/agent-install.ts`)
 * while the app runs, at which point a stale cached `null` bin would leave
 * that agent permanently unavailable until an app restart even though the
 * adapter is now on disk.
 */
export function refreshAgentCache(): CliAgentConfig[] {
  resolvedBins = null;
  cachedAgents = runDetection();
  return cachedAgents;
}

/** Clear the cache (for tests) */
export function clearAgentCache(): void {
  resolvedBins = null;
  cachedAgents = null;
}
