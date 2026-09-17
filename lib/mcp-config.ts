/**
 * Centralized MCP server configuration manager.
 *
 * libi manages ONE MCP server: its own. It never proxies, spawns or passes a
 * third-party MCP — the user's agents own their own lists
 * (`~/.claude.json`, `$CODEX_HOME/config.toml`), which libi reads but never
 * writes and never carries a key for. Two delivery shapes exist:
 *
 * 1. **ACP protocol** (in-app agent) — `getMcpServersForAcp` hands
 *    `newSession({ mcpServers })` exactly one entry: libi's HTTP endpoint,
 *    tagged with the in-app surface header. NOTE: the `claude-agent-acp`
 *    adapter sets `settingSources: ["user","project","local"]` and merges
 *    `mcpServers: { ...explicit }`, so the in-app SDK ALSO reads any workspace
 *    `.mcp.json` the user happens to have. libi itself no longer writes such a
 *    file; we inject explicitly so the in-app path never depends on the
 *    adapter keeping project/local settingSources enabled.
 *
 *    Test mode is the one exception: the fake fal and fake ElevenLabs
 *    stdio servers ride along under their real names — see
 *    `getMcpServersForAcp` and `setTestModeFakesEnabled`.
 *
 * 2. **HTTP aggregator** (bring your own CLI) — libi's streamable-HTTP MCP
 *    endpoint serves libi's tools to a CLI the user registered once via
 *    `libi connect`. Nothing is written to a workspace.
 */

import path from "path";
import { serverLogger as logger } from "@/lib/logger";
import { buildSpawnEnv } from "@/mcp/registry/spawn-env";
import { getLibiBinDir } from "@/lib/libi-home";
import { sqliteBuildDirForChildren } from "@/lib/db/native-binding";
import { isWindows } from "@/lib/platform";
import { resolveBundledSpawn } from "@/mcp/registry/local-bin-resolver";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { getLiveMcpPort, getMcpHttpChild } from "@/lib/server/lifecycle/mcp-http-handle";
import {
  SURFACE_HEADER,
  IN_APP_SURFACE,
  LIBI_MCP_ENTRY_NAME,
  LIBI_MCP_FALLBACK_ENTRY_NAME,
} from "@/lib/mcp/agent-surface";
import { isTestMode } from "@/lib/test-mode";
import { resolveNodeCommand } from "@/lib/runtime/node-runtime";
import {
  entryResolutionDiagnostic,
  resolveEntrySpawn,
} from "@/lib/runtime/compiled-entry";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { BundledMcpDef } from "@/mcp/registry/types";

/**
 * A single MCP server entry in the settings-file shape (`.claude.json`,
 * `config.toml`).
 *
 * stdio entries are plain `{ command, args, env }` (no `type` field for
 * backwards compatibility with how Claude Code reads stdio servers).
 *
 * HTTP entries set `type: "http"` and include `url` + optional `headers`.
 */
export type McpServerEntry =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

/** Index bundled defs by id for O(1) lookup. */
const BUNDLED_DEFS_BY_ID = new Map<string, BundledMcpDef>(
  BUNDLED_MCP_SERVERS.map((def) => [def.id, def]),
);

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/**
 * Build the libi MCP server entry.
 *
 * Both dev and packaged builds run the same way: tsx executes `mcp/index.ts`
 * directly, resolved from `process.cwd()` (in the packaged Electron app,
 * `electron/main.ts` chdirs to `<app root>` before Next boots, so this is
 * `Contents/Resources/app` there — the same root `electron-builder.yml`
 * ships `mcp/` + `node_modules/` into).
 *
 * tsx is resolved as `node_modules/tsx/dist/cli.mjs` — the ACTUAL package's
 * CLI entry point — run via a plain `node`, NOT `node_modules/.bin/tsx`.
 * electron-builder copies NO `.bin/` directories into the packaged app
 * (verified against the built bundle), so the bin shim this used to resolve
 * is always absent there even though `node_modules/tsx` itself is present.
 *
 * The node command comes from `resolveNodeCommand()`
 * (`lib/runtime/node-runtime.ts`), which prefers the libi-managed
 * `<LIBI_HOME>/bin/node` and only falls back to the bare name `"node"`. It is
 * NEVER `process.execPath`: under Electron, `electronFuses.runAsNode: false`
 * makes the packaged binary IGNORE `ELECTRON_RUN_AS_NODE` entirely, so
 * spawning `process.execPath` here would launch a second full Libi GUI
 * instead of running as Node — the exact trap `lib/install/npm-root.ts` had
 * to work around for the npm-install path. It cannot be a
 * `utilityProcess.fork()` either: this child is a stdio peer of the ACP
 * adapter's OWN `spawn()` call, not of libi's process.
 *
 * A bare `"node"` was the previous answer and is not good enough on its own:
 * a Finder-launched .app inherits launchd's minimal PATH, and the hardcoded
 * fallback in `electron/path-bootstrap.ts` contains no node at all on a
 * machine whose node lives in fnm/nvm/asdf/volta. The login-shell PATH probe
 * usually rescues it, but it is (correctly) non-blocking and best-effort —
 * so Category A now provisions `<LIBI_HOME>/bin/node` and this resolves to an
 * absolute path that does not depend on PATH at all.
 *
 * There is deliberately no `npx libi serve-mcp` fallback. libi publishes under
 * the SCOPED name `@nagellabs/libi`; the bare `libi` name on the public
 * registry belongs to an unrelated package (`libi@0.1.0`) with no `bin` field
 * or install scripts today — so `npx libi serve-mcp` never resolves to us, and
 * today just fails to find an executable. But `buildSpawnEnv()` hands an MCP child the
 * ENTIRE process env (`mcp/registry/spawn-env.ts`), so silently shelling out
 * to a name libi doesn't own is a latent security exposure independent of
 * whether that fallback happens to "work" today — if that package ever grows
 * a `bin` field, every packaged libi reaching this code would execute
 * third-party code with the app's full environment. `mcp/` + `node_modules/tsx`
 * are both guaranteed to exist (dev tree, or the packaged app's `files`
 * allowlist), so a missing entry point/tsx CLI here means a broken build —
 * fail loudly with a diagnostic instead of reaching for that fallback.
 *
 * DUAL MODE: an npm-INSTALLED copy cannot use tsx at all — tsx disables the
 * tsconfig `paths` matcher for any file under a `node_modules` segment, so
 * every `@/…` import in `mcp/index.ts`'s graph throws MODULE_NOT_FOUND. There,
 * the spawn targets the compiled `dist-cli/mcp/index.js` produced by
 * `scripts/build-cli.js`. `resolveEntrySpawn()` owns that choice; the packaged
 * Electron app and dev checkouts are unaffected (neither sits under
 * node_modules).
 */
/** The core MCP server's entry point, relative to libi's package root. */
const LIBI_MCP_ENTRY = "mcp/index.ts";

/**
 * The STDIO libi server's spawn spec.
 *
 * No caller inside libi since `getMcpServersForSettings()` was deleted, its
 * last one: every agent — in-app over ACP, the user's own CLI via `libi
 * connect`, and codex through its config — reaches libi over the HTTP
 * aggregator (`buildLibiHttpEntry`) instead.
 *
 * KEPT, as a decision rather than an oversight. Stdio is a supported
 * surface: `mcp/index.ts` is compiled into `dist-cli/mcp/index.js`, that file
 * is one of the artifacts `scripts/local-registry` refuses to publish without,
 * and this function is the spawn spec an MCP client is pointed at by hand —
 * an inspector, a client with no HTTP transport, a debugging session. What was
 * actually missing was evidence it still WORKS, since nothing in the product
 * exercised it: `__tests__/integration/mcp-stdio-entry-spawn.test.ts` now
 * spawns this spec and completes an `initialize` + `tools/list` handshake
 * against it. The tests around this function additionally pin the
 * packaged-build spawn resolution the HTTP and tracking entries share.
 *
 * Do not re-wire it into a config path without a reason to prefer stdio.
 */
export function buildLibiEntry(): McpServerEntry {
  const projectRoot = process.cwd();

  // Pin the spawn env (like buildTrackingEntry / the fake entries) — crucially
  // LIBI_HOME. claude-agent-acp propagates the parent env to MCP children, so
  // an unset env still worked for Claude; codex-acp SANITIZES the child env, so
  // without an explicit LIBI_HOME the libi MCP child fell back to the default
  // `~/.libi` and wrote to the WRONG home (a worktree/dev/custom-LIBI_HOME
  // session's pieces landed in the canonical DB). buildSpawnEnv() carries
  // LIBI_HOME through for every adapter. The codex `config.toml` path re-filters
  // this env through buildSafeServerEnv (secret-free on disk); the ACP path
  // passes it in-memory to the adapter (no disk leak, symmetric with Claude).
  const env = buildSpawnEnv();

  // Source+tsx in dev and in the packaged Electron app (unchanged); the
  // compiled `dist-cli/mcp/index.js` when libi is installed under
  // node_modules, where tsx cannot resolve a single `@/…` import. See
  // `lib/runtime/compiled-entry.ts` for why the switch keys off the
  // node_modules segment rather than "is dist-cli present".
  const resolved = resolveEntrySpawn(projectRoot, LIBI_MCP_ENTRY);
  if (resolved) {
    return { command: resolved.command, args: resolved.args, env };
  }

  throw new Error(
    `buildLibiEntry: could not resolve the libi MCP entry point (mcp/index.ts) — ` +
      `${entryResolutionDiagnostic(projectRoot, LIBI_MCP_ENTRY)} Deliberately not ` +
      `falling back to \`npx libi serve-mcp\`: this repo is unpublished and the ` +
      `public \`libi\` npm package belongs to an unrelated third party.`,
  );
}

/** The HTTP MCP aggregator's entry point, relative to libi's package root. */
const LIBI_MCP_HTTP_ENTRY = "mcp/http/index.ts";

/** Spawn spec for the HTTP MCP aggregator child (`mcp/http/index.ts`). */
export function buildLibiHttpEntry(): {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Whether the server runs under tsx's wrapper or as the one compiled process; the supervisor signals each differently. */
  mode: "tsx" | "compiled";
} {
  const projectRoot = process.cwd();
  const env = buildSpawnEnv();
  const resolved = resolveEntrySpawn(projectRoot, LIBI_MCP_HTTP_ENTRY);
  if (resolved) return { command: resolved.command, args: resolved.args, env, mode: resolved.mode };
  throw new Error(`buildLibiHttpEntry: could not resolve mcp/http/index.ts — ${entryResolutionDiagnostic(projectRoot, LIBI_MCP_HTTP_ENTRY)}`);
}

/**
 * The name libi's own endpoint is registered under for IN-APP ACP sessions —
 * the SAME name `libi connect` writes into the user's own agent config, on
 * purpose. The collision is what makes the in-app entry REPLACE the config one
 * instead of mounting alongside it; see `LIBI_MCP_ENTRY_NAME`
 * (`lib/mcp/agent-surface.ts`) for the measurements behind that, and
 * `lib/agents/process-manager.ts` for the codex-acp flag it needs.
 */
export const IN_APP_MCP_NAME = LIBI_MCP_ENTRY_NAME;

/**
 * Whether the two test-mode fakes (`fal-ai`, `ElevenLabs`) are attached to ACP
 * sessions. Meaningful ONLY when `isTestMode()` — production never reads it.
 *
 * Default `true`, so a plain `LIBI_TEST_MODE=1 npm run dev` behaves exactly as
 * test mode is meant to: both fakes in front of the agent at zero cost.
 *
 * The one caller that turns it OFF is `POST /api/skill-eval/configure`,
 * which sets it from the scenario's `mcps:` list. A scenario with
 * `mcps: []` is asserting "the agent has NO provider" — that is the whole
 * point of the `_meta/no-provider` scenario and of the provider gate it
 * exercises. Without this flag the fakes are attached unconditionally, the
 * scenario runs with a working fal, and its `absent` assertions fail (or, worse
 * for a future variant, pass for the wrong reason). Process-level rather than
 * per-request because `getMcpServersForAcp` is called from the session builder,
 * not from the HTTP request that configured the run.
 *
 * Flipping it invalidates the per-agent ACP cache — otherwise the standby
 * session built before `configure` ran would keep the stale entry list.
 */
let testModeFakesOn = true;

/** True when the value actually changed (and an invalidation was fired for
 *  it), so a caller does not have to invalidate again on top — see
 *  `POST /api/skill-eval/configure`. */
export function setTestModeFakesEnabled(on: boolean): boolean {
  if (testModeFakesOn === on) return false;
  testModeFakesOn = on;
  invalidateMcpConfig({ reason: on ? "test-mode-fakes-on" : "test-mode-fakes-off" });
  logger.info({ tag: "mcp-config", op: "test_mode_fakes", enabled: on }, "test-mode fakes toggled");
  return true;
}

export function testModeFakesEnabled(): boolean {
  return testModeFakesOn;
}

/**
 * The REAL upstream names the two test-mode fakes are attached under, in the
 * order they are pushed. Single-sourced because the instructions core names
 * them to the agent (`testModeCoreBanner`) and a banner that named a fake the
 * ACP list did not carry would be exactly the kind of lie that got removed.
 */
export const TEST_MODE_FAKE_NAMES = ["fal-ai", "ElevenLabs"] as const;

/**
 * Tell the running aggregator to re-read its instructions.
 * Fire-and-forget: it is normal for the child to be down (boot order, tests).
 *
 * The body carries `testModeFakes` because the aggregator renders the
 * instructions core, and the core's TEST MODE banner must name only the fakes
 * that are actually attached — a flag that lives in THIS process
 * (`testModeFakesOn`). Sending it on every reload keeps the child in step
 * without it having to ask; both sides start from the same `true` default, so
 * a child that has never seen a reload is not wrong either.
 */
export function notifyMcpHttpReload(reason: string): void {
  // While this instance's child is not running, whatever holds its port may be
  // another libi instance's aggregator, and a reload there would re-render that
  // instance's instructions with this process's test-mode flag.
  const handle = getMcpHttpChild();
  if (handle && handle.status() !== "running") return;
  const url = `http://127.0.0.1:${getLiveMcpPort()}/reload`;
  void fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason, testModeFakes: testModeFakesOn }) })
    .catch((err) => logger.debug({ err, tag: "mcp-http", op: "reload_notify_failed", reason }, "aggregator not reachable for reload"));
}

// buildFakeFalEntry / buildFakeElevenLabsEntry resolve tsx the same way
// buildLibiEntry does (node_modules/tsx/dist/cli.mjs via `node`, not the
// `.bin/tsx` shim electron-builder never copies) purely for consistency
// within this file — LIBI_TEST_MODE is dev/test-only (see lib/test-mode.ts;
// forced off in packaged production builds), `mcp/dev/**` is explicitly
// excluded from both shipped artifacts (electron-builder.yml, package.json),
// and a dev tree always has `.bin/tsx` anyway. There is no security exposure
// here either way, unlike buildLibiEntry/buildTrackingEntry which have no
// `npx libi ...` fallback to avoid at all — these two never had one.

/**
 * The names a test-mode fake is allowed to inherit from this process. This is
 * a WHITELIST, deliberately not `buildSpawnEnv()` (which copies the entire
 * `process.env`): the fakes go to the agent over ACP, and claude-agent-acp
 * serialises an ACP stdio entry's env straight into the `--mcp-config` JSON
 * on the Claude child's argv — so every name here is readable in `ps`. With
 * the whole process env, a developer's FAL_AI / ANTHROPIC_API_KEY /
 * ELEVENLABS_API_KEY sat on a command line whenever LIBI_TEST_MODE was on.
 *
 * What the fakes' import graph actually reads (grep `process.env` under
 * `mcp/dev/**` and the `lib/` modules they pull in):
 *   - LIBI_HOME        — lib/libi-home.ts: the DB, storage, recordings,
 *                        bundled ffmpeg, the port files. codex-acp sanitises
 *                        the child env, so it MUST travel explicitly.
 *   - LIBI_TEST_MODE   — lib/test-mode.ts; the fakes only exist in test mode.
 *   - LIBI_FAKE_FAL_CONFIG — mcp/dev/fake-fal/config.ts, the scenario file
 *                        (fal only, and only when the parent has one).
 *   - PATH / HOME      — node + tsx + ffmpeg resolution; PATH gets libi's bin
 *                        dir prepended exactly as buildSpawnEnv does.
 *   - LIBI_SQLITE_BINDING_DIR — lib/db/native-binding.ts: `storeFile` opens
 *                        the DB, and the child's cwd is the agent workspace,
 *                        so it cannot locate the better-sqlite3 build itself.
 * tsx needs no NODE_OPTIONS / NODE_* from us — no launcher sets any.
 */
const FAKE_MCP_ENV_NAMES = ["LIBI_HOME", "LIBI_TEST_MODE", "HOME"] as const;

/**
 * Minimal spawn env for a test-mode fake: the whitelist above plus `extra`.
 * Never spread `process.env` into this — see FAKE_MCP_ENV_NAMES.
 */
export function fakeMcpSpawnEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of FAKE_MCP_ENV_NAMES) {
    const value = process.env[name];
    if (typeof value === "string") env[name] = value;
  }
  const pathSep = isWindows() ? ";" : ":";
  env.PATH = `${getLibiBinDir()}${pathSep}${process.env.PATH ?? ""}`;
  const sqliteBuildDir = sqliteBuildDirForChildren();
  if (sqliteBuildDir) env.LIBI_SQLITE_BINDING_DIR = sqliteBuildDir;
  return { ...env, ...extra };
}

/** Test-mode only: spawn the fake-fal stdio server (masquerades as fal-ai). */
export function buildFakeFalEntry(): McpServerEntry {
  const projectRoot = process.cwd();
  const entryPoint = path.join(projectRoot, "mcp", "dev", "fake-fal", "index.ts");
  const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const tsconfig = path.join(projectRoot, "tsconfig.json");
  const scenario = process.env.LIBI_FAKE_FAL_CONFIG;
  const env = fakeMcpSpawnEnv(scenario ? { LIBI_FAKE_FAL_CONFIG: scenario } : {});
  return { command: resolveNodeCommand(), args: [tsxCli, "--tsconfig", tsconfig, entryPoint], env };
}

/** Test-mode only: spawn the fake-elevenlabs stdio server (masquerades as ElevenLabs). */
export function buildFakeElevenLabsEntry(): McpServerEntry {
  const projectRoot = process.cwd();
  const entryPoint = path.join(projectRoot, "mcp", "dev", "fake-elevenlabs", "index.ts");
  const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const tsconfig = path.join(projectRoot, "tsconfig.json");
  return { command: resolveNodeCommand(), args: [tsxCli, "--tsconfig", tsconfig, entryPoint], env: fakeMcpSpawnEnv() };
}

/**
 * A settings-shaped stdio entry as the ACP `McpServerStdio` variant. The
 * builders return `env` as a record; ACP wants `Array<{ name, value }>`, and
 * claude-agent-acp calls `server.env.map(...)` on it — a record there throws
 * inside `newSession` and the server never spawns.
 */
function toAcpStdioEntry(name: string, entry: McpServerEntry): McpServer {
  if ("type" in entry) {
    throw new Error(`toAcpStdioEntry: ${name} is an HTTP entry, not stdio`);
  }
  return {
    name,
    command: entry.command,
    args: entry.args ?? [],
    env: Object.entries(entry.env ?? {}).map(([key, value]) => ({ name: key, value })),
  };
}

/**
 * Build the libi-tracking MCP server entry.
 *
 * Delegates to the single shared resolver `resolveBundledSpawn()` so the
 * session/settings path resolves the spawn command identically to the
 * prober (`server-prober.ts`) and diagnose (`diagnose.ts`) paths. The
 * `libi-tracking` def carries `inRepoEntry`, so when the source tree + tsx
 * are present the resolver returns the tsx-direct entry; otherwise it throws
 * a diagnostic (see `resolveBundledSpawn` — no `npx libi serve-mcp-tracking`
 * fallback, same unpublished-package rationale as `buildLibiEntry()`).
 *
 * This mirrors how the core libi server's tsx entry is used everywhere —
 * one resolution function, every spawn path.
 */
export function buildTrackingEntry(): McpServerEntry {
  const def = BUNDLED_DEFS_BY_ID.get("libi-tracking");
  if (!def) {
    // Should never happen — libi-tracking is a static bundled def. Throw
    // rather than fall back to the unowned `npx libi ...` name (see
    // `resolveBundledSpawn` for the full rationale).
    throw new Error(
      "buildTrackingEntry: no bundled def found for id \"libi-tracking\" — BUNDLED_MCP_SERVERS is a static list that should always include it. This is a libi bug.",
    );
  }
  const resolved = resolveBundledSpawn(def);
  return {
    command: resolved.command,
    args: resolved.args,
    env: buildSpawnEnv(),
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

// Cache state is pinned to `globalThis`, NOT plain module-level variables.
//
// Next.js builds this module's graph more than once per process: API route
// handlers (app/api/*) and the long-lived server runtime (instrumentation.ts +
// SessionManager) can each get their OWN instance of this module. With plain
// module-level caches, an `invalidateMcpConfig()` triggered from a route — the
// Settings "add API key" PATCH, or the agent's retry/notify HTTP callback —
// clears THAT instance's cache and fires THAT instance's invalidate callback,
// while the SessionManager (a different instance) keeps serving its
// frozen-at-startup MCP list. Symptom: a newly-configured bundled MCP (e.g.
// ElevenLabs once its API key is added) never reaches a new chat until a full
// server restart, and no `acp_cache_built` ever logs (the SessionManager's
// per-agent cache is a permanent hit).
//
// Pinning to `globalThis` — the same pattern SessionManager (`globalForSM`) and
// the db client (`globalForDrizzle`) use — makes every module instance share
// ONE settings cache, ONE per-agent ACP cache, and ONE invalidate-callback
// slot, so invalidation from any instance reaches the SessionManager's reads.
//
// The per-agent ACP cache (`cachedAcpByAgent`) exists because the single HTTP
// entry's `?agent=` query picks the instruction dialect (claude vs codex), so
// the URL isn't identical across agents even though both get the same
// aggregator.
const MCP_CONFIG_GLOBAL_KEY = "__libiMcpConfig_v1";

interface McpConfigState {
  cachedAcpByAgent: Map<string, McpServer[]>;
  onInvalidateCallback: ((opts: { reason: string }) => void) | null;
}

const globalForMcpConfig = globalThis as unknown as {
  [MCP_CONFIG_GLOBAL_KEY]?: McpConfigState;
};

function mcpConfigState(): McpConfigState {
  let state = globalForMcpConfig[MCP_CONFIG_GLOBAL_KEY];
  if (!state) {
    state = {
      cachedAcpByAgent: new Map<string, McpServer[]>(),
      onInvalidateCallback: null,
    };
    globalForMcpConfig[MCP_CONFIG_GLOBAL_KEY] = state;
  }
  return state;
}

/**
 * The MCP list for `newSession({ mcpServers })`.
 *
 * PRODUCTION: exactly one entry — libi's HTTP endpoint. The header marks the
 * in-app surface (`lib/mcp/agent-surface.ts`); `?agent=` picks the instruction
 * dialect. Every other MCP the agent has comes from the agent's OWN config
 * (`~/.claude.json`, `$CODEX_HOME/config.toml`), which libi reads but never
 * writes and never carries a key for.
 *
 * The entry is named `libi` — the SAME name `libi connect` writes — precisely
 * so that, on a machine that has run `libi connect`, this session-scoped entry
 * REPLACES the user's headerless one instead of mounting libi a second time.
 * Both adapters resolve the collision in favour of the ACP entry (Claude:
 * `--mcp-config` beats config; Codex: a `thread/start` config override
 * deep-merges over the config layers, once codex-acp's own name filter is off
 * — `lib/agents/process-manager.ts`), and BOTH leave every other config MCP
 * alone. `LIBI_MCP_ENTRY_NAME` carries the measurements.
 *
 * TEST MODE: the ONE case where libi passes extra MCPs over ACP — the
 * fake fal and fake ElevenLabs stdio servers, under the REAL upstream names
 * (`fal-ai`, `ElevenLabs`) so the agent walks the identical tool path at zero
 * cost and every call is recorded for the skill-eval harness. `isTestMode()`
 * is forced off in packaged production builds (`lib/test-mode.ts`) and
 * `mcp/dev/**` is excluded from both shipped artifacts.
 *
 * Cached per agent because `?agent=` differs; `invalidateMcpConfig` clears it.
 */
export function getMcpServersForAcp(agentId: string): McpServer[] {
  const state = mcpConfigState();
  const cached = state.cachedAcpByAgent.get(agentId);
  if (cached) return cached;
  const dialect = agentId === "codex" ? "codex" : "claude";
  const entries: McpServer[] = [{
    type: "http",
    name: IN_APP_MCP_NAME,
    // This instance's own port in every supervisor state, never a guess that
    // may name another instance's aggregator (see `getLiveMcpPort`).
    url: `http://127.0.0.1:${getLiveMcpPort()}/mcp?agent=${dialect}`,
    headers: [{ name: SURFACE_HEADER, value: IN_APP_SURFACE }],
  }];
  if (isTestMode() && testModeFakesEnabled()) {
    entries.push(
      toAcpStdioEntry(TEST_MODE_FAKE_NAMES[0], buildFakeFalEntry()),
      toAcpStdioEntry(TEST_MODE_FAKE_NAMES[1], buildFakeElevenLabsEntry()),
    );
  }
  state.cachedAcpByAgent.set(agentId, entries);
  logger.info(
    {
      tag: "mcp-config",
      op: "acp_cache_built",
      agentId,
      names: entries.map((e) => e.name),
      testMode: isTestMode(),
    },
    "ACP MCP entries built",
  );
  return entries;
}

/**
 * The same list, with libi's own entry renamed to
 * `LIBI_MCP_FALLBACK_ENTRY_NAME` — the ONE-SHOT retry list for the Codex edge
 * where the deliberate name collision is fatal instead of replacing.
 *
 * Only `lib/sessions/session-manager.ts` calls this, and only after observing
 * `isLibiMcpEntryConfigError` on a `newSession` rejection. Everything else in
 * the list (the test-mode fakes) is passed through untouched, and nothing is
 * cached: this is a cold path that should stay rare, and caching a degraded
 * shape risks it outliving the config that caused it.
 *
 * Renaming re-creates the duplicated tool surface for that session — the
 * entry no longer collides, so codex mounts the user's config entry too. That
 * is the trade being made on purpose: `LIBI_MCP_FALLBACK_ENTRY_NAME` carries
 * the reasoning, and `lib/agents/mcp-tool-id.ts` keeps the resulting wire
 * segment resolving to `libi`.
 */
export function getMcpServersForAcpFallback(agentId: string): McpServer[] {
  return getMcpServersForAcp(agentId).map((entry) =>
    entry.name === IN_APP_MCP_NAME
      ? { ...entry, name: LIBI_MCP_FALLBACK_ENTRY_NAME }
      : entry,
  );
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

/**
 * Register a callback to run when MCP config is invalidated.
 *
 * The callback always refreshes the standby session so the next agent
 * session sees the new config. Active sessions are never disturbed.
 *
 * Stored on the `globalThis`-backed state (see `mcpConfigState`) so the
 * single registration made by the SessionManager's module instance is the
 * one `invalidateMcpConfig()` fires, regardless of which instance invalidates.
 */
export function onMcpConfigInvalidated(cb: (opts: { reason: string }) => void): void {
  mcpConfigState().onInvalidateCallback = cb;
}

/**
 * Invalidate the MCP config cache, tell the HTTP aggregator to reload, and
 * refresh the standby ACP session so the next agent session gets updated
 * servers.
 *
 * Called when the aggregator port or the test-mode fakes flag changes, and
 * after Category B's pre-warm phase to swap the cold-cache standby for a warm
 * one.
 *
 * The optional `reason` is logged so investigations can correlate a cache
 * drop with what triggered it (settings CRUD, retry, pre-warm, db-resolve).
 */
export function invalidateMcpConfig(opts?: { reason?: string }): void {
  const reason = opts?.reason ?? "unspecified";
  const state = mcpConfigState();
  state.cachedAcpByAgent.clear();
  notifyMcpHttpReload(reason);

  // No agent config is written from here any more: registration is a command
  // the user submits on the Agents page.

  // Refresh standby session so next ACP session gets updated servers. The
  // callback decides whether to also fan out and refresh active sessions —
  // see `onMcpConfigInvalidated` for the contract.
  try {
    state.onInvalidateCallback?.({ reason });
  } catch (err) {
    logger.warn({ err, reason }, "Failed to refresh standby session after MCP config change");
  }

  logger.info(
    { tag: "mcp-config", op: "invalidate", reason },
    `MCP config invalidated (${reason})`,
  );
}
