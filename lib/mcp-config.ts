/**
 * Centralized MCP server configuration manager.
 *
 * All MCP server list construction, caching, and delivery flows through
 * this single module. Two delivery mechanisms exist:
 *
 * 1. **ACP protocol** (in-app agent) — servers passed explicitly via
 *    `newSession({ mcpServers })`. NOTE: the `claude-agent-acp` adapter sets
 *    `settingSources: ["user","project","local"]` and merges
 *    `mcpServers: { ...explicit }`, so the in-app SDK ALSO reads the workspace
 *    `.mcp.json` we write for BYO CLIs. libi (same server name) dedupes across
 *    the two — verified: the ACP standby connects libi exactly once, and libi
 *    tools are callable via `.mcp.json` alone. We still inject explicitly so
 *    the in-app path never depends on the adapter keeping project/local
 *    settingSources enabled.
 *
 * 2. **Settings file** (bring your own CLI) — servers written to
 *    `.claude/settings.local.json` for standalone Claude Code sessions
 *    that read settings directly from disk (e.g., `npx libi --connect-agent`).
 */

import fs from "fs";
import path from "path";
import { serverLogger as logger } from "@/lib/logger";
import { getDb } from "@/lib/db/client";
import { mcpServers as mcpServersTable } from "@/lib/db/schema/sqlite";
import { and, eq, ne } from "drizzle-orm";
import { buildSpawnEnv } from "@/mcp/registry/spawn-env";
import { resolveBundledSpawn } from "@/mcp/registry/local-bin-resolver";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { getAgentDirWriteTargets, getConnectedAgentDir } from "@/lib/libi-home";
import { inAppSurfaceEnvEntry } from "@/lib/mcp/agent-surface";
import { buildSafeServerEnv, buildReferenceServerEnv } from "@/lib/mcp/safe-env";
import { isTestMode } from "@/lib/test-mode";
import { resolveNodeCommand } from "@/lib/runtime/node-runtime";
import {
  entryResolutionDiagnostic,
  resolveEntrySpawn,
} from "@/lib/runtime/compiled-entry";
import { syncCodexGlobalMcpsIfConnected } from "@/lib/codex-config/sync";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { McpServerRecord } from "@/lib/db/schema/types";
import type { BundledMcpDef } from "@/mcp/registry/types";

/**
 * A single MCP server entry as written to `.claude/settings.local.json`.
 *
 * stdio entries are plain `{ command, args, env }` (no `type` field for
 * backwards compatibility with how Claude Code reads stdio servers).
 *
 * HTTP entries set `type: "http"` and include `url` + optional `headers`.
 * Header values may have been substituted from the row's `envVars`.
 */
export type McpServerEntry =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

/**
 * Replace `${VAR}` placeholders in a header value with values from the
 * row's `envVars`. Missing vars resolve to an empty string — keeps the
 * row valid even when config is partial (the install-status filter
 * already prevents `needs_config` rows from reaching this code path).
 */
function substituteVars(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => env[key] ?? "");
}

/** Index bundled defs by id for O(1) lookup. */
const BUNDLED_DEFS_BY_ID = new Map<string, BundledMcpDef>(
  BUNDLED_MCP_SERVERS.map((def) => [def.id, def]),
);

/** Build a single settings entry from a DB row. Returns null for malformed rows.
 *
 * For bundled MCPs with a pinned npm package, the spawn command is resolved
 * via `resolveBundledSpawn` so the agent (and ACP) hits the local
 * `~/.libi/node_modules/.bin/<bin>` instead of `npx -y <pkg>@<ver>`. The DB
 * row's `command`/`args` act only as a fallback if the install hasn't
 * landed yet. For custom (user-added) rows the DB row is authoritative. */
function buildEntryForRow(row: McpServerRecord): McpServerEntry | null {
  const envVars: Record<string, string> = row.envVars ? JSON.parse(row.envVars) : {};

  if (row.type === "http") {
    if (!row.url) return null;
    const rawHeaders: Record<string, string> = row.headers ? JSON.parse(row.headers) : {};
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      headers[k] = substituteVars(v, envVars);
    }
    return { type: "http", url: row.url, headers };
  }

  const def = BUNDLED_DEFS_BY_ID.get(row.id);
  // Bundled defs that ship as a pinned npm package OR in-repo (libi-tracking)
  // resolve their spawn command through the single shared resolver, so the
  // settings path matches the prober/diagnose paths exactly. The DB row's
  // command/args is only the resolver's last-resort fallback.
  if (def && ((def.npmPackage && def.pinnedVersion) || def.inRepoEntry)) {
    const resolved = resolveBundledSpawn(def);
    return {
      command: resolved.command,
      args: resolved.args,
      env: buildSpawnEnv(envVars),
    };
  }

  if (!row.command) return null;
  const args: string[] = row.args ? JSON.parse(row.args) : [];
  return {
    command: row.command,
    args,
    env: buildSpawnEnv(envVars),
  };
}

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

export function buildLibiEntry(): McpServerEntry {
  const projectRoot = process.cwd();

  // Pin the spawn env (like buildTrackingEntry / the fake entries) — crucially
  // LIBI_HOME. claude-agent-acp propagates the parent env to MCP children, so
  // an unset env still worked for Claude; codex-acp SANITIZES the child env, so
  // without an explicit LIBI_HOME the libi MCP child fell back to the default
  // `~/.libi` and wrote to the WRONG home (a worktree/dev/custom-LIBI_HOME
  // session's pieces landed in the canonical DB). buildSpawnEnv() carries
  // LIBI_HOME through for every adapter. The .mcp.json/BYO path re-filters this
  // env through buildSafeServerEnv (secret-free on disk); the ACP path passes
  // it in-memory to the adapter (no disk leak, symmetric with Claude).
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

// buildFakeFalEntry / buildFakeElevenLabsEntry resolve tsx the same way
// buildLibiEntry does (node_modules/tsx/dist/cli.mjs via `node`, not the
// `.bin/tsx` shim electron-builder never copies) purely for consistency
// within this file — LIBI_TEST_MODE is dev/test-only (see lib/test-mode.ts;
// forced off in packaged production builds), `mcp/dev/**` is explicitly
// excluded from both shipped artifacts (electron-builder.yml, package.json),
// and a dev tree always has `.bin/tsx` anyway. There is no security exposure
// here either way, unlike buildLibiEntry/buildTrackingEntry which have no
// `npx libi ...` fallback to avoid at all — these two never had one.

/** Test-mode only: spawn the fake-fal stdio server (masquerades as fal-ai). */
export function buildFakeFalEntry(): McpServerEntry {
  const projectRoot = process.cwd();
  const entryPoint = path.join(projectRoot, "mcp", "dev", "fake-fal", "index.ts");
  const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const tsconfig = path.join(projectRoot, "tsconfig.json");
  return { command: resolveNodeCommand(), args: [tsxCli, "--tsconfig", tsconfig, entryPoint], env: buildSpawnEnv() };
}

/** Test-mode only: spawn the fake-elevenlabs stdio server (masquerades as ElevenLabs). */
export function buildFakeElevenLabsEntry(): McpServerEntry {
  const projectRoot = process.cwd();
  const entryPoint = path.join(projectRoot, "mcp", "dev", "fake-elevenlabs", "index.ts");
  const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const tsconfig = path.join(projectRoot, "tsconfig.json");
  return { command: resolveNodeCommand(), args: [tsxCli, "--tsconfig", tsconfig, entryPoint], env: buildSpawnEnv() };
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

/**
 * Build the full MCP server config from the database.
 * Includes libi itself + enabled external servers with status "installed" or "not_required".
 *
 * All MCP child spawns must build env via `buildSpawnEnv` from
 * `mcp/registry/spawn-env.ts` — both probe (`server-prober.ts`) and here.
 *
 * Logs the resulting set under the `mcp-config` tag with one line per cache
 * build (`reason`-tagged). Filtered rows are logged at debug so investigations
 * can see exactly why a particular MCP didn't make it into a session.
 */
/**
 * Bundled rows flagged `noServer` are surfaced in Settings / list_bundled_mcps
 * and own an install plan, but their work runs inside libi's own MCP/tools
 * (e.g. `whisper` → analysis_transcribe_audio). They must never be spawned —
 * excluded here the same way the synthesized libi-core row is.
 */
const NO_SERVER_IDS = new Set(
  BUNDLED_MCP_SERVERS.filter((d) => d.noServer).map((d) => d.id),
);

function buildMcpServers(reason: string): Record<string, McpServerEntry> {
  const servers: Record<string, McpServerEntry> = {
    libi: buildLibiEntry(),
  };

  const filtered: Array<{ id: string; reason: string; serverStatus?: string; installStatus?: string }> = [];

  try {
    const db = getDb();
    // Pull every enabled non-libi row so we can log what got filtered out
    // and why — that data is invaluable when an MCP "isn't accessible".
    const allEnabled = db
      .select()
      .from(mcpServersTable)
      .where(and(eq(mcpServersTable.enabled, true), ne(mcpServersTable.id, "libi")))
      .all();

    for (const row of allEnabled) {
      if (NO_SERVER_IDS.has(row.id)) {
        filtered.push({ id: row.id, reason: "no-server-capability-row" });
        continue;
      }
      if (isTestMode() && row.id === "fal-ai") {
        // Masquerade: spawn the fake-fal stdio server under the real "fal-ai"
        // server name so the agent walks the identical generation tool path
        // (recommend_model → endpoint_id → run_model/submit_job) without spending
        // credits, and every call is recorded for the skill-eval harness.
        servers[row.name] = buildFakeFalEntry();
        continue;
      }
      if (isTestMode() && row.id === "elevenlabs") {
        // Masquerade: spawn the fake-elevenlabs stdio server under the real
        // "ElevenLabs" server name so the agent walks the identical audio tool
        // path (text_to_speech / voice_clone / compose_music / …) at zero cost,
        // and every call is recorded for the skill-eval harness. Placed BEFORE
        // the needs_config gate so it injects even without ELEVENLABS_API_KEY.
        servers[row.name] = buildFakeElevenLabsEntry();
        continue;
      }
      // The 13 tracking tools are now hosted on the always-on core `libi`
      // MCP (see mcp/server.ts → registerTrackingTools). Spawning the
      // standalone `libi-tracking` MCP in the same session would register
      // duplicate `libi.*` tool names and reintroduce the very
      // session-race fragility we removed. Keep the DB row + bundled def
      // (Settings shows it for the lazy tracking-engine dependency card +
      // install plan) but never spawn it as a session MCP.
      if (row.id === "libi-tracking") {
        filtered.push({ id: row.id, reason: "hosted-in-core-libi" });
        continue;
      }
      // Tier-2 MCPs run via npx (or HTTP) by default — they're "available"
      // for the agent to use unless the install state explicitly blocks them.
      // `needs_config` means a required env var (e.g. API key) is missing;
      // `failed` means a previous probe permanently failed. Otherwise we
      // include the row even if installStatus is `pending` — the npx spawn
      // path is the install path for most MCPs.
      if (["needs_config", "failed"].includes(row.installStatus)) {
        filtered.push({
          id: row.id,
          reason: "install-not-ready",
          installStatus: row.installStatus,
        });
        continue;
      }
      if (!["unknown", "starting", "up"].includes(row.serverStatus)) {
        filtered.push({
          id: row.id,
          reason: "server-status-excluded",
          serverStatus: row.serverStatus,
        });
        continue;
      }
      // buildEntryForRow routes bundled in-repo defs (libi-tracking) and
      // pinned-npm defs through resolveBundledSpawn() — the same shared
      // resolver the prober/diagnose paths use — so the tsx-direct entry is
      // substituted here too when the source tree is present. No per-id
      // special-casing needed: the def's `inRepoEntry` drives it.
      const entry = buildEntryForRow(row);
      if (!entry) {
        filtered.push({ id: row.id, reason: "malformed-row" });
        continue;
      }
      servers[row.name] = entry;
    }
  } catch (err) {
    logger.warn({ err, reason, tag: "mcp-config" }, "Failed to load external MCP servers from DB");
  }

  // Dump per-entry spawn details. envKeys (not envValues) — keeps secrets
  // out of the log but lets us spot a missing PATH / HOME / NODE_OPTIONS.
  // `command` + `args` go in verbatim — we need to confirm the actual binary
  // and flags we're passing to claude-agent-acp / Claude Code.
  const includedDetails = Object.entries(servers).map(([name, entry]) => {
    if ("type" in entry && entry.type === "http") {
      return { name, transport: "http" as const, url: entry.url, headerKeys: Object.keys(entry.headers ?? {}) };
    }
    const stdio = entry as { command: string; args?: string[]; env?: Record<string, string> };
    return {
      name,
      transport: "stdio" as const,
      command: stdio.command,
      args: stdio.args ?? [],
      envKeys: stdio.env ? Object.keys(stdio.env).sort() : [],
    };
  });

  logger.info(
    {
      tag: "mcp-config",
      op: "cache_build",
      reason,
      includedCount: Object.keys(servers).length,
      included: Object.keys(servers),
      includedDetails,
      filteredCount: filtered.length,
      filtered,
    },
    `MCP config built (${Object.keys(servers).length} included, ${filtered.length} filtered, reason=${reason})`,
  );

  return servers;
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
// The per-agent ACP cache (`cachedAcpByAgent`) exists because different agents
// have different transport capabilities (claude-agent-acp rejects HTTP+SSE;
// codex-acp accepts HTTP) so the emitted server list isn't identical across
// agents — see ACP_HTTP_CAPABLE.
const MCP_CONFIG_GLOBAL_KEY = "__libiMcpConfig_v1";

interface McpConfigState {
  cachedSettings: Record<string, McpServerEntry> | null;
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
      cachedSettings: null,
      cachedAcpByAgent: new Map<string, McpServer[]>(),
      onInvalidateCallback: null,
    };
    globalForMcpConfig[MCP_CONFIG_GLOBAL_KEY] = state;
  }
  return state;
}

/**
 * Agents whose ACP adapter accepts HTTP-transport MCP servers in
 * `newSession({ mcpServers })`.
 *
 *  - `claude-agent-acp` v0.29.1+ accepts HTTP entries (verified empirically
 *    on 2026-05-26 via `scripts/probe-fal-http-mcp.ts` against fal.ai's HTTP
 *    MCP at `https://mcp.fal.ai/mcp`, plus by reading
 *    `node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js:1058`
 *    and `@anthropic-ai/claude-agent-sdk@0.2.112`'s
 *    `McpServerConfig = McpStdio | McpSSE | McpHttp | …` union). An earlier
 *    investigation note (`docs-local/superpowers/notes/2026-05-23-codex-acp-investigation.md`)
 *    concluded claude-agent-acp rejected HTTP — that conclusion is now stale.
 *  - `@agentclientprotocol/codex-acp` accepts HTTP entries (it advertises
 *    `mcpCapabilities.http: true`).
 *
 * Match against libi's internal `agentId` values from
 * `lib/agents/acp/agent-registry.ts` (`claude-code`, `codex`),
 * not the user-facing display names. The bare `"claude"` form is kept for
 * back-compat in case any older caller still hands that in.
 *
 * SSE is silently dropped by codex-acp and historically unsupported by
 * claude-agent-acp; keep SSE skipped for both pending a fresh probe.
 */
const ACP_HTTP_CAPABLE = new Set<string>(["claude", "claude-code", "codex"]);

/**
 * Get MCP servers in settings format (for writing .claude/settings.local.json).
 * Cached — call `invalidateMcpConfig()` when config changes.
 */
export function getMcpServersForSettings(): Record<string, McpServerEntry> {
  const state = mcpConfigState();
  if (!state.cachedSettings) {
    state.cachedSettings = buildMcpServers("settings");
  }
  return state.cachedSettings;
}

/**
 * Get MCP servers in ACP protocol format (for `newSession({ mcpServers })`).
 * Cached per agentId — call `invalidateMcpConfig()` when config changes.
 *
 * HTTP entries are included only for agents in `ACP_HTTP_CAPABLE` (currently
 * codex). For other agents (claude), HTTP rows are skipped because
 * `claude-agent-acp` rejects the request when an HTTP entry is present.
 * HTTP rows are still emitted into the settings file for BYO-CLI mode.
 */
export function getMcpServersForAcp(agentId: string): McpServer[] {
  const state = mcpConfigState();
  const cached = state.cachedAcpByAgent.get(agentId);
  if (cached) return cached;

  const httpCapable = ACP_HTTP_CAPABLE.has(agentId);
  const settings = getMcpServersForSettings();
  const entries: McpServer[] = [];
  const httpSkipped: string[] = [];
  const httpIncluded: string[] = [];

  for (const [name, entry] of Object.entries(settings)) {
    if ("type" in entry && entry.type === "http") {
      if (!httpCapable) {
        httpSkipped.push(name);
        continue;
      }
      entries.push({
        type: "http",
        name,
        url: entry.url,
        headers: Object.entries(entry.headers ?? {}).map(([n, value]) => ({
          name: n,
          value,
        })),
      });
      httpIncluded.push(name);
      continue;
    }
    // Coexist note: libi is ALSO discoverable by the in-app SDK via the
    // workspace `.mcp.json` (project settingSource) — verified callable through
    // ACP without this explicit entry. We inject it here too, belt-and-
    // suspenders, so the in-app path is robust if the adapter ever stops
    // reading project/local settings. Same server name → deduped, no double-spawn.
    const stdio = entry as { command: string; args?: string[]; env?: Record<string, string> };
    const envPairs = stdio.env
      ? Object.entries(stdio.env).map(([k, v]) => ({ name: k, value: v }))
      : [];
    // Mark the libi core MCP as the in-app chat surface ONLY on the ACP
    // `newSession` channel. Surface-gated tools (e.g. libi.show_in_chat) read
    // this to register only for the in-app chat; the settings-file channel
    // (terminal / BYO-CLI) never sets it. See lib/mcp/agent-surface.ts.
    if (name === "libi") {
      envPairs.push(inAppSurfaceEnvEntry());
    }
    entries.push({
      name,
      command: stdio.command,
      args: stdio.args ?? [],
      env: envPairs,
    });
  }

  if (httpSkipped.length > 0) {
    logger.warn(
      { tag: "mcp-config", op: "acp_skip_http", agentId, skipped: httpSkipped },
      `Skipping HTTP MCP servers for ACP (transport not supported by agent=${agentId})`,
    );
  }
  logger.info(
    {
      tag: "mcp-config",
      op: "acp_cache_built",
      agentId,
      httpCapable,
      includedCount: entries.length,
      included: entries.map((s) => s.name),
      // Per-entry spawn/transport details. Stdio: command + args + env keys
      // (values stripped). HTTP: url + header keys (values stripped). Lets
      // us confirm exactly what gets handed to the ACP adapter.
      includedDetails: entries.map((s) => {
        if ("type" in s && (s.type === "http" || s.type === "sse")) {
          return {
            name: s.name,
            transport: s.type,
            url: s.url,
            headerKeys: (s.headers ?? []).map((h) => h.name).sort(),
          };
        }
        // Only the stdio transport variant lacks a `type` discriminant in the
        // McpServer union (SDK 0.25 added an `acp` variant); narrow to it.
        const stdio = s as Extract<McpServer, { command: string }>;
        return {
          name: stdio.name,
          transport: "stdio" as const,
          command: stdio.command,
          args: stdio.args,
          envKeys: (stdio.env ?? []).map((e) => e.name).sort(),
        };
      }),
      httpIncludedCount: httpIncluded.length,
      httpIncluded,
      httpSkippedCount: httpSkipped.length,
      httpSkipped,
    },
    `ACP MCP cache built for agent=${agentId} (${entries.length} servers, ${httpIncluded.length} http, ${httpSkipped.length} http skipped)`,
  );

  state.cachedAcpByAgent.set(agentId, entries);
  return entries;
}

// ---------------------------------------------------------------------------
// Settings file
// ---------------------------------------------------------------------------

/**
 * Server names libi manages. Used by `writeSettingsFile` to refresh libi's
 * own entries in a (possibly user-owned) `.mcp.json` without dropping servers
 * the user added themselves — matters for `--connect-agent`, where `.mcp.json`
 * lives in the user's repo. Includes disabled rows so a server disabled in
 * libi's Settings is removed from `.mcp.json` rather than lingering.
 */
function libiManagedServerNames(): Set<string> {
  const names = new Set<string>(["libi"]);
  try {
    const db = getDb();
    for (const row of db.select({ name: mcpServersTable.name }).from(mcpServersTable).all()) {
      names.add(row.name);
    }
  } catch {
    // DB unavailable — managed set is just the core libi server.
  }
  return names;
}

/**
 * Map of server name → RAW (unsubstituted) HTTP headers from the DB, e.g.
 * `{ Authorization: "Bearer ${FAL_KEY}" }`. Used when writing the EXTERNAL
 * connect-agent `.mcp.json` so the file references the env var instead of the
 * substituted literal secret value `buildEntryForRow` would otherwise bake in.
 */
function rawHttpHeadersByName(): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  try {
    const db = getDb();
    for (const row of db.select().from(mcpServersTable).all()) {
      if (row.type === "http" && row.headers) {
        try {
          const parsed = JSON.parse(row.headers);
          if (parsed && typeof parsed === "object") map.set(row.name, parsed);
        } catch {
          // Malformed headers JSON — skip; the substituted entry is the fallback.
        }
      }
    }
  } catch {
    // DB unavailable — no raw headers; callers fall back to the built entry.
  }
  return map;
}

/**
 * Ensure `.gitignore` in an external connect-agent dir excludes the agent
 * config files. Idempotent: only appends entries not already present, creating
 * the file if absent. Best-effort — a failure here must never block the
 * settings-file write (the primary secret-free guarantee).
 */
function ensureConnectAgentGitignore(dir: string, entries: string[]): void {
  const gitignorePath = path.join(dir, ".gitignore");
  let content = "";
  try {
    content = fs.readFileSync(gitignorePath, "utf-8");
  } catch {
    // No existing .gitignore — we'll create it.
  }
  const present = new Set(
    content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
  );
  const missing = entries.filter((e) => !present.has(e));
  if (missing.length === 0) return;
  const prefix = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  const block =
    prefix +
    "# Added by libi --connect-agent — references API keys & agent config; do not commit\n" +
    missing.join("\n") +
    "\n";
  try {
    fs.writeFileSync(gitignorePath, content + block);
  } catch (err) {
    logger.warn(
      { err, tag: "security", op: "connect_agent_gitignore_failed", dir },
      "Failed to write .gitignore in connect-agent dir",
    );
  }
}

/**
 * Write .mcp.json + .claude/settings.local.json for Claude Code.
 *
 * Claude Code reads MCP server definitions from `.mcp.json` (not from
 * `mcpServers` in settings files — verified against v2.1.170). Server
 * definitions go there; `enableAllProjectMcpServers: true` in settings
 * suppresses the per-session "approve N servers?" prompt.
 *
 * Used by standalone CLI sessions (`npx libi --connect-agent`) that read
 * settings directly from disk. For ACP sessions, MCP servers are passed
 * explicitly via `newSession({ mcpServers })` — see `getMcpServersForAcp()`.
 */
export function writeSettingsFile(workspaceDir: string): void {
  // Persist a SECRET-FREE copy: the in-memory entries carry buildSpawnEnv()'s
  // full process env (every service's API key), but a stdio server written to
  // .mcp.json on disk must only carry the operational vars + its OWN declared
  // requiredEnvVars + LIBI_HOME. HTTP entries have no env and pass through.
  // (The in-app ACP path keeps the full in-memory env — nothing is persisted
  // there — so this filtering is scoped to the file write only.)
  // Is this the EXTERNAL --connect-agent target (the user's own, often
  // git-tracked, dir)? If so, write env-var REFERENCES instead of baked-in
  // literal secret values so a routine `git add -A && push` cannot leak keys.
  // The internal ~/.libi/agent dir keeps the current (literal safe-env)
  // behavior — nothing user-committable lives there.
  const connectedDir = getConnectedAgentDir();
  const isExternalTarget =
    connectedDir !== null && path.resolve(workspaceDir) === connectedDir;
  const rawHeaders = isExternalTarget ? rawHttpHeadersByName() : null;

  const rawServers = getMcpServersForSettings();
  const mcpServers: Record<string, McpServerEntry> = {};
  for (const [name, entry] of Object.entries(rawServers)) {
    if ("type" in entry && entry.type === "http") {
      if (isExternalTarget) {
        // Prefer the RAW (unsubstituted) headers so a `${FAL_KEY}` reference
        // is written, not `Bearer <real key>`. Fall back to the built entry
        // only if the raw headers are unavailable (never re-bake a secret).
        const raw = rawHeaders?.get(name);
        mcpServers[name] = raw
          ? { type: "http", url: entry.url, headers: raw }
          : { type: "http", url: entry.url, headers: {} };
      } else {
        mcpServers[name] = entry;
      }
      continue;
    }
    const stdio = entry as {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };
    mcpServers[name] = {
      command: stdio.command,
      args: stdio.args,
      env: isExternalTarget
        ? buildReferenceServerEnv(name, stdio.env)
        : buildSafeServerEnv(name, stdio.env),
    };
  }

  // 1. Server DEFINITIONS go in `.mcp.json` — the file Claude Code actually
  //    reads for project MCP servers. (Its CLI ignores a `mcpServers` key in
  //    settings.local.json; verified against Claude Code v2.1.170.) Merge into
  //    any existing `.mcp.json`: refresh every libi-managed name, preserve
  //    servers the user added themselves (the `--connect-agent` case).
  fs.mkdirSync(workspaceDir, { recursive: true });
  const mcpJsonPath = path.join(workspaceDir, ".mcp.json");
  let mcpJson: Record<string, unknown> & { mcpServers?: Record<string, unknown> } = {};
  if (fs.existsSync(mcpJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
      // Only adopt a plain object — an array or primitive would lose servers
      // when we assign `.mcpServers` onto it, so treat those as malformed.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        mcpJson = parsed;
      }
    } catch {
      // Malformed — start fresh.
    }
  }
  const managed = libiManagedServerNames();
  // A user entry whose name collides with a libi-managed name is treated as
  // managed — libi's definition supersedes it (because the `managed.has(name)`
  // filter excludes it from `preserved`).
  const preserved: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(mcpJson.mcpServers ?? {})) {
    if (!managed.has(name)) preserved[name] = def;
  }
  mcpJson.mcpServers = { ...preserved, ...mcpServers };
  fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + "\n");

  // 2. settings.local.json auto-enables every project `.mcp.json` server so a
  //    new BYO session never shows the "N new MCP servers found — approve?"
  //    prompt. It no longer carries the (CLI-ignored) `mcpServers` block.
  //    Preserve any other pre-existing keys (permissions, etc.).
  const claudeDir = path.join(workspaceDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, "settings.local.json");
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      // Only adopt a plain object — an array or primitive would lose existing
      // keys when we assign onto it, so treat those as malformed.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed;
      }
    } catch {
      // Malformed — start fresh.
    }
  }
  delete existing.mcpServers;
  existing.enableAllProjectMcpServers = true;
  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + "\n");

  // 3. For an EXTERNAL connect-agent dir, keep these agent-config files out of
  //    the user's git history — they reference API keys / contain agent config.
  if (isExternalTarget) {
    ensureConnectAgentGitignore(workspaceDir, [
      ".mcp.json",
      ".claude/settings.local.json",
    ]);
  }
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
 * Invalidate the MCP config cache, rewrite the settings file, and refresh
 * the standby ACP session so the next agent session gets updated servers.
 *
 * Called when MCP servers are added, removed, or reconfigured, and after
 * Category B's pre-warm phase to swap the cold-cache standby for a warm one.
 *
 * The optional `reason` is logged so investigations can correlate a cache
 * drop with what triggered it (settings CRUD, retry, pre-warm, db-resolve).
 */
export function invalidateMcpConfig(opts?: { reason?: string }): void {
  const reason = opts?.reason ?? "unspecified";
  const state = mcpConfigState();
  state.cachedSettings = null;
  state.cachedAcpByAgent.clear();

  // Rewrite agent config files in every agent dir — the default
  // (<libi-home>/agent/) plus the connected external dir in connect-agent
  // mode, so an outside CLI always reads fresh config. Guard each dir
  // independently: a connected dir is user-supplied and may be read-only,
  // and a failure there must never skip libi's own (always-writable) dir.
  // The warning names the failing dir so the cause is actionable.
  for (const dir of getAgentDirWriteTargets()) {
    try {
      writeSettingsFile(dir);
    } catch (err) {
      logger.warn({ err, reason, dir }, "Failed to rewrite settings file after MCP config change");
    }
  }

  // Sync the user's global ~/.codex MCP entries via codex's own `mcp add/remove`
  // — but ONLY when they opted in (connected) AND this is the canonical instance
  // (double-gated worktree safety). Default: no-op, nothing written to ~/.codex.
  // Fire-and-forget — it has its own error handling and never throws; we don't
  // want to block the caller (typically an API mutation) on disk I/O.
  void syncCodexGlobalMcpsIfConnected().catch((err) => {
    logger.warn({ err, reason, tag: "codex-config", op: "invalidate_error" }, "Failed to sync codex global MCPs after MCP config change");
  });

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
