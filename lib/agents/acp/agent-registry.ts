import fs from "fs";
import path from "path";

import { claudeNativeBinaryPresent } from "@/lib/agents/claude-native-binary";
import {
  codexNativeBinaryMissingError,
  codexNativeBinaryPresent,
} from "@/lib/agents/codex-native-binary";
import { serverLogger as logger } from "@/lib/logger";
import { resolveNodeCommand } from "@/lib/runtime/node-runtime";
import {
  claudeAdapterUnavailableReason,
  getAgentInstallRoot,
  resolveClaudeAdapterBin,
  resolveBinIn,
  resolveInstalledAdapterBin,
  resolveRepoLocalAdapterBin,
} from "@/lib/agents/runtime-install";
import type { AgentUnavailableReason } from "@/lib/agents/types";

export interface CliAgentConfig {
  id: string;
  name: string;
  /** Command to spawn for ACP communication */
  command: string;
  /** Args for the ACP spawn command */
  args: string[];
  /**
   * The CLI a user would associate with this agent. INFORMATIONAL ONLY —
   * availability is never decided by a PATH probe for either agent (see
   * `detectClaudeCode` / `detectCodex` below: both adapters resolve their
   * engine by package, never through PATH). Kept on the config because
   * `/api/agent/detect` reports it. The one place a real `which codex`
   * matters — the `codex mcp add` install surface — does its own probe
   * (`lib/codex-config/codex-cli.ts#codexCliOnPath`).
   */
  detectCommand: string;
  envHints: string[];
  installed: boolean;
  /** Set only when `installed` is false — why, for a disabled selector row. */
  unavailableReason?: AgentUnavailableReason;
}

type ResolvedBin = { command: string; args: string[] };

/** A resolved Claude adapter bin plus the npm tree root it belongs to. */
type ClaudeBinResolution = { bin: ResolvedBin; root: string };

/**
 * A resolved codex-acp bin plus the npm tree root it belongs to — null root
 * means the bundled adapter was NOT found locally and the command is the npx
 * fallback (dev convenience only; never counted as installed).
 */
type CodexBinResolution = { bin: ResolvedBin; root: string | null };

/**
 * npm-tree roots that could hold libi's dependencies, nearest first.
 *
 * `startDir` (= cwd, libi's package root in every server run mode) first — the
 * dev checkout, where `node_modules/` is a CHILD of the root. But npm HOISTS:
 * an installed copy at `<x>/node_modules/@nagellabs/libi` — the packaged
 * Electron runtime (`Resources/libi-bundle/node_modules/@nagellabs/libi`,
 * which `electron/main.ts` chdirs to) and an `npx @nagellabs/libi` install
 * alike — has its dependencies in `<x>/node_modules`, an ANCESTOR of the
 * package root rather than a child of it, and NO nested `node_modules` of its
 * own. So every `node_modules` ancestor also yields a candidate tree root
 * (its parent). Same bug class `workerReadScopes`
 * (`lib/storyboard/render/index.ts`) and `packageRoot()` already document;
 * checking only `<cwd>/node_modules` made a fully-present packaged codex-acp
 * report "missing — reinstall libi".
 *
 * Pure so the layouts are testable without a real tree.
 */
export function codexCandidateTreeRoots(startDir: string): string[] {
  const roots = [startDir];
  const segments = startDir.split(path.sep);
  for (let i = segments.length - 1; i > 0; i--) {
    if (segments[i] !== "node_modules") continue;
    const root = segments.slice(0, i).join(path.sep);
    roots.push(root === "" ? path.sep : root);
  }
  return roots;
}

/**
 * Resolve the bundled codex-acp adapter bin. `@agentclientprotocol/codex-acp`
 * (Apache-2.0) is a production dependency of libi, so in any real install
 * `node_modules/.bin/codex-acp` exists in the npm tree libi resolves from —
 * `<cwd>/node_modules/.bin` in a dev checkout, or the HOISTED
 * `<cwd>/../../.bin` when libi itself is installed under `node_modules` (the
 * packaged runtime, `npx @nagellabs/libi`) — see `codexCandidateTreeRoots`.
 * The returned `root` is the tree root the bin came from, so
 * `codexNativeBinaryPresent(root)` probes the SAME tree for the engine.
 *
 * The npx fallback is a harmless dev convenience for a tree that was never
 * npm-installed — freely redistributable, so unlike claude-agent-acp an npx
 * fetch is licence-safe — but it is an unpinned network fetch, so
 * `detectCodex` never reports it as installed. It fetches the SCOPED package:
 * an unscoped `codex-acp` does not exist on the registry (`npm view codex-acp`
 * → 404), so the old `npx codex-acp` fallback could never have worked at all.
 *
 * The `.bin/codex-acp` shim is a `#!/usr/bin/env node` script, so it goes
 * through `spawnViaNodeIfScript` for the same reason the Claude adapter does:
 * a Finder-launched packaged app has no `node` on its launchd PATH.
 */
function resolveCodexBin(): CodexBinResolution {
  for (const root of codexCandidateTreeRoots(process.cwd())) {
    // Was `execSync('test -x "<path>"')`. `test` is not a cmd.exe builtin and
    // there is no `test.exe` on a stock Windows, so that command failed on
    // EVERY Windows machine and codex was reported not-installed regardless of
    // what was on disk. `resolveBinIn` is the check that already knows the
    // platform's bin file names (`.cmd` / `.exe`) and uses F_OK rather than
    // X_OK on win32, where the execute bit is not a thing.
    const localBin = resolveBinIn(
      path.join(root, "node_modules", ".bin"),
      "codex-acp",
    );
    if (localBin) return { bin: spawnViaNodeIfScript(localBin), root };
  }
  return { bin: { command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"] }, root: null };
}

/**
 * Resolve the Claude ACP adapter bin: repo-local checkout first, then the
 * runtime-installed copy under `~/.libi/agents` (see
 * `lib/agents/runtime-install.ts#resolveClaudeAdapterBin`). Unlike
 * `resolveBin` above, this NEVER falls back to npx — the adapter transitively
 * pulls `@anthropic-ai/claude-agent-sdk` (+ its ~212MB platform binary),
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
    logger.warn(
      { tag: "agent-registry", op: "claude_adapter_unresolved" },
      "Claude Code support is still installing — Codex and Terminal are available",
    );
    return null;
  }
  // Which npm tree this bin came from decides where its native binary must
  // live: the adapter resolves @anthropic-ai/claude-agent-sdk relative to its
  // OWN location, so a repo-local bin execs the checkout's binary and an
  // agent-root bin execs ~/.libi/agents'. Checking the wrong root would either
  // bless a broken tree or condemn a healthy one.
  const root = binPath === repoLocal ? repoRoot : getAgentInstallRoot();
  return { bin: spawnViaNodeIfScript(binPath), root };
}

/**
 * `node_modules/.bin/claude-agent-acp` is a symlink to a `#!/usr/bin/env node`
 * script, so spawning it directly requires `node` on the PATH of the SPAWNING
 * process — which, in a Finder-launched packaged app whose login-shell PATH
 * probe timed out, it is not (see `lib/runtime/node-runtime.ts`). Resolve the
 * link and run it through `resolveNodeCommand()` instead, so the adapter
 * launches off an absolute interpreter path rather than a shebang lookup.
 *
 * A Windows `.cmd` shim gets the SAME treatment, via its own JS target: since
 * the CVE-2024-27980 fix (Node ≥18.20.2 / ≥20.12.0) `child_process.spawn()`
 * REFUSES a `.cmd`/`.bat` file with `EINVAL` unless `shell: true`. Handing one
 * back unchanged here therefore produced an adapter that could never launch on
 * Windows while detection cheerfully reported it installed.
 *
 * `shell: true` is deliberately NOT the fix: it is the very thing the CVE was
 * about, and it re-introduces quoting hazards on any path containing a space —
 * `C:\Users\First Last\…` is the common case, not an edge one. Reading the
 * shim's own target and running it through `resolveNodeCommand()` keeps one
 * mechanism for all three platforms.
 *
 * Anything that resolves to neither (a genuine native launcher) is spawned
 * unchanged — those need no interpreter, and handing them to node would break
 * them.
 */
export function spawnViaNodeIfScript(
  binPath: string,
  realpath: (p: string) => string = fs.realpathSync,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf-8"),
): ResolvedBin {
  let target = binPath;
  try {
    target = realpath(binPath);
  } catch {
    /* not a link / unreadable — fall through with the original path */
  }
  if (/\.(c|m)?js$/.test(target)) {
    return { command: resolveNodeCommand(), args: [target] };
  }
  if (/\.cmd$/i.test(target)) {
    const js = resolveCmdShimTarget(target, readFile);
    if (js) return { command: resolveNodeCommand(), args: [js] };
  }
  return { command: binPath, args: [] };
}

/**
 * The JS file an npm-generated `.cmd` shim actually runs, or null.
 *
 * npm's cmd-shim writes the target as `"%dp0%\..\<pkg>\<entry>.js"`, where
 * `%dp0%` is the shim's own directory. Anything that does not match that shape
 * (a hand-written batch file, a shim format npm may change) returns null and
 * the caller falls back to spawning the shim as-is — no worse than before.
 */
export function resolveCmdShimTarget(
  cmdPath: string,
  readFile: (p: string) => string,
): string | null {
  let text: string;
  try {
    text = readFile(cmdPath);
  } catch {
    return null;
  }
  const m = /%dp0%\\(.+?\.(?:c|m)?js)"/i.exec(text);
  if (!m) return null;
  return path.resolve(path.dirname(cmdPath), m[1].replace(/\\/g, path.sep));
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

function getKnownAgents(): Omit<CliAgentConfig, "installed">[] {
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
    },
    {
      id: "codex",
      name: "Codex",
      command: bins["codex-acp"].bin.command,
      args: bins["codex-acp"].bin.args,
      detectCommand: "codex",
      envHints: ["OPENAI_API_KEY"],
    },
  ];
}

let cachedAgents: CliAgentConfig[] | null = null;

/**
 * Claude Code availability = the two halves libi actually installs, and
 * NOTHING on PATH.
 *
 * The adapter's `claudeCliPath()`
 * (`node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js`)
 * resolves the CLI as `CLAUDE_CODE_EXECUTABLE`, else the
 * `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` package via a require
 * bound to the SDK. It never reads PATH, and libi puts no `claude` on PATH —
 * `~/.libi/bin` holds ffmpeg, ffprobe, node, uv and yt-dlp. So a `which
 * claude` gate made a COMPLETE, successful runtime install report "not
 * installed": libi downloads the 212MB CLI and then refuses to admit it has
 * it, unless the user separately installed Claude Code — which every
 * developer machine has, which is why this hid for so long.
 *
 * WAS THE PATH PROBE A PROXY FOR "SIGNED IN"? It reads like one (running
 * `claude` once is how you get credentials), and the concern behind it is
 * real: with no credentials the adapter answers `initialize` and
 * `session/new` happily and then fails `session/prompt` with ACP
 * `-32000 Authentication required` (verified against adapter 0.44.0 with an
 * isolated empty HOME). But PATH is unsound as a proxy in BOTH directions:
 *   - `npm i -g @anthropic-ai/claude-code` and never logging in passes it,
 *     so it never actually prevented that failure; and
 *   - a signed-in user fails it in the very place this matters. A
 *     Finder-launched packaged app inherits launchd's minimal PATH, and
 *     `electron/path-bootstrap.ts`'s synchronous fallback lists only
 *     Homebrew + /usr/local + system dirs — not `~/.local/bin` (where
 *     Claude Code's official installer lands) nor an fnm/nvm/volta npm-global
 *     dir. The login-shell probe that would find those is deliberately
 *     async, best-effort and 2s-bounded. This is the same PATH hole
 *     `lib/runtime/node-runtime.ts` exists to work around for `node`.
 * Credentials are also not the only auth path (ANTHROPIC_API_KEY, Bedrock /
 * Vertex env), so gating availability on a credential probe instead would
 * just move the false negative. libi already models auth separately and
 * deliberately doesn't gate on it (`envHints`, and `provider-registry.ts`'s
 * `requiresApiKey: false`), and `lib/claude/plan-usage.ts` treats absent
 * credentials as an expected state (`no_token`), not a broken install.
 *
 * So availability answers "can libi run this agent", and an unauthenticated
 * user gets an honest `Authentication required` at their first message
 * instead of being told to install a CLI they do not need.
 */
function detectClaudeCode(
  agent: Omit<CliAgentConfig, "installed">,
  claudeRoot: string | null,
): CliAgentConfig {
  // The adapter couldn't be resolved anywhere (no repo-local checkout, no
  // runtime install yet). This must never spawn `npx claude-agent-acp` in a
  // packaged app, so it can't be reported installed on any other evidence.
  if (!agent.command || !claudeRoot) {
    return { ...agent, installed: false, unavailableReason: claudeAdapterUnavailableReason(null) };
  }
  // A resolved adapter bin is only HALF the install. The adapter is ~40KB of
  // JS that must exec @anthropic-ai/claude-agent-sdk's ~212MB native binary,
  // which arrives as an optionalDependency — and npm exits 0 when an
  // optional dependency fails. Reporting "installed" off the adapter alone
  // therefore advertises an agent that throws `Claude native binary not
  // found` at the first session/new. The install path already gates on this
  // (`pendingInstallReason`); this is the reporting half.
  //
  // Unlike the install path, this does NOT exempt a dev checkout: a checkout
  // installed with --omit=optional genuinely cannot run Claude Code, and the
  // reason to skip it there (avoiding a redundant 212MB download libi cannot
  // put in the repo anyway) is an install concern, not a reporting one.
  // CLAUDE_CODE_EXECUTABLE still counts as present — see
  // `resolveClaudeNativeBinary`.
  if (!claudeNativeBinaryPresent(claudeRoot)) {
    const unavailableReason = claudeAdapterUnavailableReason(claudeRoot);
    logger.warn(
      {
        tag: "agent-registry",
        op: "claude_native_binary_missing",
        root: claudeRoot,
        reason: unavailableReason.code,
      },
      "Claude adapter is present but its native binary is missing — reporting Claude Code as not installed",
    );
    return { ...agent, installed: false, unavailableReason };
  }
  // Both halves verified on disk — that IS the install. No PATH probe.
  return { ...agent, installed: true };
}

/**
 * Codex availability = the two halves libi actually SHIPS, and NOTHING on
 * PATH.
 *
 * The old gate here was `which codex` — the exact false negative
 * `detectClaudeCode` above removed for Claude, and it was wrong for the same
 * structural reason: `@agentclientprotocol/codex-acp` EMBEDS its engine. On
 * the ACP path it reads `process.env["CODEX_PATH"]` — undefined unless the
 * user sets it — and otherwise resolves the BUNDLED
 * `@openai/codex/bin/codex.js` launcher, which in turn resolves the platform
 * optionalDependency `@openai/codex-<platform>-<arch>` (a ~271MB Rust binary
 * at `vendor/<target-triple>/bin/codex`). It never falls back to a `codex` on
 * PATH. (Its separate `codex-acp login` subcommand DOES default to `"codex"`
 * on PATH — libi never invokes that, and it is not what availability means.)
 * Verified empirically (codex-acp 1.1.8, darwin-arm64, 2026-08-02): driven
 * from libi's OWN ACP SDK 0.25 client against an empty isolated CODEX_HOME,
 * it completes the `initialize` handshake with full capabilities (both sides
 * negotiate PROTOCOL_VERSION 1 despite the adapter shipping SDK 1.3, so the
 * 0.25<->1.3 gap is not a wire break); the only missing thing is auth —
 * `session/new` fails with ACP `-32000
 * Authentication required` (note: at session/new, earlier than Claude's
 * session/prompt). Auth is credentials (`~/.codex/auth.json` ChatGPT login,
 * CODEX_API_KEY, OPENAI_API_KEY), which — exactly as for Claude — no cheap
 * boot-time probe can answer honestly, so availability deliberately does NOT
 * mean "signed in".
 *
 * `which codex` was wrong in both directions: a user without the codex CLI
 * was told Codex is unavailable when the bundled adapter runs fine, and in a
 * Finder-launched packaged app even a user WITH codex installed can fail the
 * probe (launchd's minimal PATH + path-bootstrap's Homebrew-only fallback —
 * the same hole `detectClaudeCode` documents). What DOES determine
 * runnability is what this checks: the bundled adapter bin resolved locally,
 * plus its platform engine binary — an optionalDependency npm silently skips
 * on failure, the same partial-install trap as Claude's native binary.
 *
 * The ONE surface where `which codex` is the genuinely honest question — the
 * `codex mcp add` install flow, which shells out to the user's own codex CLI
 * — now does its own probe (`lib/codex-config/codex-cli.ts#codexCliOnPath`)
 * instead of borrowing this flag.
 */
function detectCodex(
  agent: Omit<CliAgentConfig, "installed">,
  codexRoot: string | null,
): CliAgentConfig {
  // No local codex-acp bin — the command fell back to `npx codex-acp`, an
  // unpinned network fetch. Fine as a dev convenience, but never report it as
  // an install: codex-acp is a production dependency, so a missing local bin
  // means this libi install is broken, not that the user must add anything.
  if (!codexRoot) {
    return {
      ...agent,
      installed: false,
      unavailableReason: {
        code: "not_installed" as const,
        message:
          "libi's bundled Codex adapter is missing from this install — reinstall libi to restore it.",
      },
    };
  }
  // `CODEX_PATH` names an engine explicitly, and the adapter reads it FIRST —
  // before it ever looks for the bundled `@openai/codex` launcher (the module
  // comment on `lib/agents/codex-native-binary.ts` says so, and libi forwards
  // the whole env to the child via `buildSpawnEnv`). So a user who points it
  // at their own build has a working setup that the engine-binary check below
  // would hard-block for a file the adapter is never going to consult. This
  // mirrors the `CLAUDE_CODE_EXECUTABLE` override on the Claude side.
  const codexPathOverride = process.env.CODEX_PATH;
  if (codexPathOverride && codexPathOverride.trim().length > 0) {
    logger.info(
      { tag: "agent-registry", op: "codex_path_override", path: codexPathOverride },
      "CODEX_PATH is set — trusting it instead of probing the bundled engine binary",
    );
    return { ...agent, installed: true };
  }

  // The adapter bin is only the launcher. Its ~188MB engine binary arrives as
  // a platform optionalDependency, and npm exits 0 when an optional
  // dependency fails — reporting installed off the bin alone advertises an
  // agent whose first spawn exits 1 with "Failed to locate … binary".
  if (!codexNativeBinaryPresent(codexRoot)) {
    logger.warn(
      {
        tag: "agent-registry",
        op: "codex_native_binary_missing",
        root: codexRoot,
      },
      "codex-acp adapter is present but its engine binary is missing — reporting Codex as not installed",
    );
    return {
      ...agent,
      installed: false,
      unavailableReason: {
        code: "install_failed" as const,
        message: "Codex support is incomplete — reinstall libi to finish installing it.",
        detail: codexNativeBinaryMissingError(codexRoot),
      },
    };
  }
  // Both halves verified on disk — that IS the install. No PATH probe.
  return { ...agent, installed: true };
}

function runDetection(): CliAgentConfig[] {
  const bins = getBins();
  const claudeRoot = bins["claude-agent-acp"]?.root ?? null;
  const codexRoot = bins["codex-acp"].root;
  return getKnownAgents().map((agent) => {
    if (agent.id === "claude-code") return detectClaudeCode(agent, claudeRoot);
    return detectCodex(agent, codexRoot);
  });
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
 * Re-detect agents (called by user via "Refresh agents" in UI).
 *
 * Also clears the resolved-bin cache: the Claude adapter can finish its
 * background runtime install (`ensureClaudeAdapterInstalled`) after boot, at
 * which point a stale cached `null` bin would leave Claude Code permanently
 * unavailable until an app restart even though the adapter is now on disk.
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
