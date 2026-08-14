import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { BUNDLED_MCPS } from "./registry";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { invalidateMcpConfig } from "@/lib/mcp-config";
import { probeAndPersist } from "@/mcp/registry/server-prober";
import { getSessionManager } from "@/lib/sessions/session-manager";
import { packageRoot } from "@/lib/runtime/package-root";

// Repo root resolved relative to this file's location, NOT process.cwd().
// The libi MCP child spawns with cwd=~/.libi/agent/ (the agent workspace),
// so process.cwd() can't be used to find files inside the libi package.
//
// This used to be `path.dirname(fileURLToPath(import.meta.url))` + "../..".
// `import.meta` is ESM-only: tsx's hybrid shim makes it work alongside
// `__dirname`/`require` in the same file, which is NOT real Node behaviour and
// is exactly what let this ESM idiom ship here while nine sibling files used
// the CJS one. Compiled to CommonJS by `scripts/build-cli.js`, esbuild emits a
// WARNING (not an error) and substitutes `{}`, so the line became
// `fileURLToPath(undefined)` — a TypeError at module load, crashing the MCP
// child on startup. `packageRoot()` walks up to the nearest package.json, so it
// is also correct from the compiled `dist-cli/` mirror, which sits one level
// deeper than the source tree. An eslint rule now bans `import.meta` across
// lib/ and mcp/ (eslint.config.mjs), and the compile step fails the build on
// esbuild's `empty-import-meta` warning, so the next one can't ship silently.
const REPO_ROOT = packageRoot();

export interface GetInstallPlanInput {
  mcpId: string;
}

export type GetInstallPlanResult =
  | { success: true; mcpId: string; plan: string; planPath: string }
  | { success: false; error: string; knownIds: string[] };

/**
 * Return the markdown install plan for a tier-2 bundled MCP. The agent
 * reads this verbatim and follows the steps using its own tools.
 *
 * Reads from disk on every call so authored edits to plan files (during
 * dev or after a libi upgrade) take effect without a restart.
 */
export async function getInstallPlan(
  input: GetInstallPlanInput,
): Promise<GetInstallPlanResult> {
  const def = BUNDLED_MCPS.find((d) => d.id === input.mcpId);
  if (!def) {
    // If it exists in the full registry but is tier-1, give a clearer message
    const inFullRegistry = BUNDLED_MCP_SERVERS.find((d) => d.id === input.mcpId);
    if (inFullRegistry) {
      return {
        success: false,
        error: `"${input.mcpId}" is a tier-1 core dependency installed by libi at startup — there is no per-mcp install plan. If it's not installed, restart libi and check the CLI output.`,
        knownIds: BUNDLED_MCPS.map((d) => d.id),
      };
    }
    return {
      success: false,
      error: `Unknown bundled MCP id "${input.mcpId}".`,
      knownIds: BUNDLED_MCPS.map((d) => d.id),
    };
  }
  if (!def.installPlanPath) {
    return {
      success: false,
      error: `Bundled MCP "${input.mcpId}" has no installPlanPath set in registry.ts — this is a libi bug.`,
      knownIds: BUNDLED_MCPS.map((d) => d.id),
    };
  }
  const absolute = path.resolve(REPO_ROOT, def.installPlanPath);
  try {
    const plan = await fs.readFile(absolute, "utf-8");
    return { success: true, mcpId: input.mcpId, plan, planPath: def.installPlanPath };
  } catch (err) {
    return {
      success: false,
      error: `Could not read install plan at ${def.installPlanPath}: ${(err as Error).message}`,
      knownIds: BUNDLED_MCPS.map((d) => d.id),
    };
  }
}

export type DepStatus =
  | "not_installed"
  | "installing"
  | "installed"
  | "failed"
  | "needs_config";

export interface UpdateDepStatusInput {
  mcpId: string;
  status: DepStatus;
  /** Optional version string ("0.8.4", "2026.03.17"). Stored alongside status. */
  version?: string;
  /** Optional error message — only meaningful when status="failed". */
  error?: string;
  /** Optional env-vars merge — used for API keys etc. Existing keys preserved unless overwritten. */
  env?: Record<string, string>;
}

export type UpdateDepStatusResult =
  | { success: true; mcpId: string; newStatus: DepStatus }
  | { success: false; error: string };

/**
 * Record an install-progress update from the agent. The agent calls this
 * after each step in a `bundled-mcps/plans/*.md` install plan. We write
 * to the DB and invalidate the MCP-config cache so newly-spawned ACP
 * sessions (or a manual restart_acp_session) see the updated state.
 *
 * Tier-1 MCPs are rejected — their state is owned by libi's Category A
 * install loop and the agent must not touch it.
 */
export async function updateDepStatus(
  input: UpdateDepStatusInput,
): Promise<UpdateDepStatusResult> {
  const def = BUNDLED_MCP_SERVERS.find((d) => d.id === input.mcpId);
  if (!def) {
    return { success: false, error: `Unknown MCP id "${input.mcpId}"` };
  }
  if (def.installFlow !== "tier-2") {
    return {
      success: false,
      error: `"${input.mcpId}" is a tier-1 core dependency — agent cannot update its install state. libi owns this dep.`,
    };
  }

  const db = getDb();
  const existing = db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, input.mcpId))
    .all()[0];
  if (!existing) {
    return {
      success: false,
      error: `DB row missing for "${input.mcpId}" — seedDatabase() should have created it. This is a libi bug.`,
    };
  }

  const updatedEnvVars = input.env
    ? JSON.stringify({
        ...JSON.parse(existing.envVars ?? "{}"),
        ...input.env,
      })
    : existing.envVars;

  db.update(mcpServers)
    .set({
      installStatus: input.status,
      installError: input.status === "failed" ? (input.error ?? null) : null,
      envVars: updatedEnvVars,
      updatedAt: new Date(),
    })
    .where(eq(mcpServers.id, input.mcpId))
    .run();

  invalidateMcpConfig({ reason: "agent-update-dep-status" });

  return { success: true, mcpId: input.mcpId, newStatus: input.status };
}

export interface RecheckMcpInput {
  mcpId: string;
}

export type RecheckMcpResult =
  | {
      success: true;
      mcpId: string;
      status: "up" | "down";
      durationMs: number;
      error?: string;
    }
  | { success: false; error: string };

/**
 * Probe the MCP server and persist the result. Used by the agent after
 * it finishes the install steps to verify the server can actually boot.
 *
 * Works for tier-1 and tier-2 — even though the agent typically only
 * triggers this for tier-2, there's no harm letting it re-check tier-1
 * (e.g. when debugging "why is ffmpeg not working").
 */
export async function recheckMcp(
  input: RecheckMcpInput,
): Promise<RecheckMcpResult> {
  const def = BUNDLED_MCP_SERVERS.find((d) => d.id === input.mcpId);
  if (!def) {
    return { success: false, error: `Unknown MCP id "${input.mcpId}"` };
  }
  const probe = await probeAndPersist(def);
  return {
    success: true,
    mcpId: input.mcpId,
    status: probe.status,
    durationMs: probe.durationMs,
    error: probe.error ?? undefined,
  };
}

/** Empty for now; reserved for future per-session overrides. */
export type RestartAcpSessionInput = object;

export interface RestartAcpSessionContext {
  /** MCP request context — `sessionId` is injected by mcp/server.ts. */
  sessionId: string;
}

export interface RestartAcpSessionResult {
  success: true;
  message: string;
}

/**
 * Reload the agent's current ACP session so newly-installed MCP servers
 * become available. Returns immediately; the actual teardown + recreation
 * runs asynchronously via setImmediate (so the tool result reaches the SDK
 * before the reload tears the session down).
 *
 * The agent MUST end its current response after calling this — per the
 * spike findings (docs-local/superpowers/plans/spikes/2026-05-15-acp-reload.md),
 * the in-flight prompt is cancelled by the reload. The user's next message
 * will run against the reloaded session with new tools visible.
 */
export async function restartAcpSession(
  _input: RestartAcpSessionInput,
  ctx: RestartAcpSessionContext,
): Promise<RestartAcpSessionResult> {
  getSessionManager().scheduleSessionReload(ctx.sessionId);
  return {
    success: true,
    message:
      "Install complete. End your current response and tell the user: 'Installed. To use the new tools, please open a new chat and re-send your request.' (Reason: this session was created before the MCP existed; claude-agent-acp loads MCP servers at session-creation time, so a new chat is the simplest reliable way to pick them up.)",
  };
}
