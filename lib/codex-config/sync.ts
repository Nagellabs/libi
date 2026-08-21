/**
 * Connect-state sync orchestration for the user's GLOBAL `~/.codex` MCP entries.
 *
 * When the user opts in ("Connect Codex", persisted in `settings.codex`), libi
 * keeps their global Codex config in sync with libi's desired MCP server set by
 * shelling out to codex's OWN `codex mcp add`/`remove` (never editing the TOML
 * directly — see `codex-cli.ts`). A sidecar manifest (`managed-manifest.ts`)
 * records the names libi added so we only ever remove libi-owned entries — the
 * user's hand-added servers (never in the manifest) are structurally safe.
 *
 * This module REPLACES the old corrupting marker-splice config.toml writer at
 * both config-writer seams. By default (`connected=false`) libi writes NOTHING to
 * `~/.codex` — the sync is a no-op unless the user explicitly opted in.
 *
 * DOUBLE-GATED worktree safety: `syncCodexGlobalMcpsIfConnected` performs ZERO
 * codex writes unless BOTH the user is connected AND this is the canonical libi
 * instance (`isCanonicalLibiInstance()` — false in worktrees / test mode /
 * skill-eval). A copied DB with `connected=true` in a worktree still writes
 * nothing: the canonical guard wins.
 *
 * Every function swallows errors and NEVER throws — a codex-sync failure must
 * never break the caller (a config-writer seam or a startup path). Wrapper
 * failures are surfaced only as `lastSyncStatus: "error"` in the setting.
 */

import fs from "node:fs";
import type { McpServerEntry } from "@/lib/mcp-config";
import type { CodexCliResult } from "./codex-cli";
import { mcpAdd, mcpRemove, toCodexServerName } from "./codex-cli";
import { readManagedNames, writeManagedNames } from "./managed-manifest";
import { isCanonicalLibiInstance, resolveCodexHome } from "./canonical";
import { getMcpServersForSettings } from "@/lib/mcp-config";
import { buildSafeServerEnv } from "@/lib/mcp/safe-env";
import { getLibiHome } from "@/lib/libi-home";
import {
  getCodexConnectSetting,
  setCodexConnectSetting,
} from "@/lib/db/settings";
import { serverLogger as logger } from "@/lib/logger";

/** The subset of the codex-cli surface the sync layer needs. */
export interface SyncCli {
  mcpAdd: (
    name: string,
    entry: McpServerEntry,
    opts?: { codexHome?: string },
  ) => Promise<CodexCliResult>;
  mcpRemove: (
    name: string,
    opts?: { codexHome?: string },
  ) => Promise<CodexCliResult>;
}

/** The subset of the managed-manifest surface the sync layer needs. */
export interface SyncManifest {
  readManagedNames: (codexHome: string) => Set<string>;
  writeManagedNames: (codexHome: string, names: Set<string>) => void;
}

/** Injectable dependencies — all defaulted to the real implementations. */
export interface SyncDeps {
  cli?: SyncCli;
  manifest?: SyncManifest;
  getEntries?: () => Record<string, McpServerEntry>;
  isCanonical?: () => boolean;
  codexHome?: string;
  /** The libi home to pin into each stdio entry's env. Defaults to getLibiHome(). */
  libiHome?: string;
}

interface ResolvedDeps {
  cli: SyncCli;
  manifest: SyncManifest;
  getEntries: () => Record<string, McpServerEntry>;
  isCanonical: () => boolean;
  codexHome: string;
  libiHome: string;
}

function resolve(deps: SyncDeps): ResolvedDeps {
  return {
    cli: deps.cli ?? { mcpAdd, mcpRemove },
    manifest: deps.manifest ?? { readManagedNames, writeManagedNames },
    getEntries: deps.getEntries ?? getMcpServersForSettings,
    isCanonical: deps.isCanonical ?? isCanonicalLibiInstance,
    codexHome: deps.codexHome ?? resolveCodexHome(),
    libiHome: deps.libiHome ?? getLibiHome(),
  };
}

/**
 * Produce a codex-safe entry: a SECRET-FREE env pinned to `LIBI_HOME`.
 *
 * Two problems this solves:
 *  1. **Home resolution.** Codex does NOT propagate its own environment to MCP
 *     children (it sanitizes it), so an un-pinned libi child's `getLibiHome()`
 *     falls back to `~/.libi` — reading the WRONG database (a worktree's codex
 *     would list the canonical app's pieces). `buildSafeServerEnv` pins
 *     `LIBI_HOME` (not `LIBI_PORT` — the child reads `<LIBI_HOME>/port` at
 *     runtime, so a saved config never goes stale on a port change).
 *  2. **Secret leak.** Bundled entries carry `buildSpawnEnv()` (the ENTIRE
 *     process env, incl. `ELEVENLABS_API_KEY`, `FAL_KEY`, `git_token`, OAuth
 *     scopes). Persisting that into `~/.codex/config.toml` is unacceptable.
 *     `buildSafeServerEnv` keeps only operational vars + this server's declared
 *     `requiredEnvVars` (its OWN key) + LIBI_HOME; codex merges its base env for
 *     the rest. `originalName` (pre-sanitizing) drives the requiredEnvVars
 *     lookup. HTTP entries (fal-ai) have no env and pass through.
 */
function codexSafeEntry(
  entry: McpServerEntry,
  originalName: string,
  libiHome: string,
): McpServerEntry {
  if ("type" in entry && entry.type === "http") return entry;
  const stdio = entry as {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  };
  return {
    command: stdio.command,
    args: stdio.args,
    env: buildSafeServerEnv(originalName, stdio.env, { libiHome }),
  };
}

/**
 * Sync libi's desired MCP set into the global Codex config.
 *
 * - `mcpAdd` every desired entry (codex's add is add-or-update, so this adds new
 *   and updates existing — no remove-first needed).
 * - `mcpRemove` every manifest name NOT in the desired set (libi-owned orphans).
 * - Rewrite the manifest to the desired names (always — even if a cli call
 *   failed, so the manifest reflects intent).
 *
 * Persists `lastSyncStatus: "ok"` on full success, `"error"` if any cli call
 * returned `{ok:false}`. Never throws.
 */
export async function syncCodexGlobalMcps(deps: SyncDeps = {}): Promise<void> {
  const { cli, manifest, getEntries, codexHome, libiHome } = resolve(deps);

  let hadError = false;
  try {
    // codex refuses to load when CODEX_HOME doesn't exist ("...path does not
    // exist"). On the canonical app ~/.codex already exists; a worktree's
    // scoped home won't until the first install — create it so `codex mcp add`
    // can write its config there. Best-effort: if this fails, codex's own add
    // reports the real error; never let it abort the whole sync.
    //
    // `codexHome` is injectable for tests, so this cannot just call
    // `ensureCodexHome()` — but it is the same guarantee, and the shared
    // helper in ./canonical.ts is where the reasoning lives.
    try {
      fs.mkdirSync(codexHome, { recursive: true });
    } catch {
      // ignore — surfaced downstream by the codex cli calls if it matters
    }

    // codex refuses server names outside [A-Za-z0-9_-] (e.g. "YouTube
    // Downloader"). Sanitize each name to a codex-valid form instead of
    // dropping it, so the codex agent still gets those tools (e.g. the yt-dlp
    // downloader). Sanitize is deterministic, so re-sync is idempotent; the
    // manifest tracks the SANITIZED names actually written to the config.
    const allDesired = getEntries();
    const desired: Array<{
      codexName: string;
      originalName: string;
      entry: McpServerEntry;
    }> = [];
    const renamed: Array<{ from: string; to: string }> = [];
    for (const [name, entry] of Object.entries(allDesired)) {
      const codexName = toCodexServerName(name);
      desired.push({ codexName, originalName: name, entry });
      if (codexName !== name) renamed.push({ from: name, to: codexName });
    }
    if (renamed.length > 0) {
      logger.info(
        { tag: "codex-config", op: "sync_rename_invalid_names", renamed },
        "renamed codex-invalid MCP server names for the global install",
      );
    }
    const desiredNames = new Set(desired.map((d) => d.codexName));
    const managed = manifest.readManagedNames(codexHome);

    // Add-or-update every desired entry with a secret-free, LIBI_HOME-pinned env
    // (codex doesn't pass its own env to MCP children, and we must never persist
    // inherited secrets into the codex config). The ORIGINAL name drives the
    // requiredEnvVars lookup; the SANITIZED name is what codex stores.
    for (const { codexName, originalName, entry } of desired) {
      const res = await cli.mcpAdd(
        codexName,
        codexSafeEntry(entry, originalName, libiHome),
        { codexHome },
      );
      if (!res.ok) hadError = true;
    }

    // Remove libi-owned orphans (in the manifest, no longer desired). Names
    // outside the manifest — the user's own servers — are never targeted.
    for (const name of managed) {
      if (desiredNames.has(name)) continue;
      const res = await cli.mcpRemove(name, { codexHome });
      if (!res.ok) hadError = true;
    }

    manifest.writeManagedNames(codexHome, desiredNames);
  } catch (err) {
    hadError = true;
    logger.warn(
      { err, tag: "codex-config", op: "sync_error" },
      "syncCodexGlobalMcps failed",
    );
  }

  persistStatus(hadError ? "error" : "ok");
}

/**
 * Disconnect: remove EVERY libi-managed name from the global Codex config and
 * empty the manifest. The user's own servers are never in the manifest, so they
 * are left untouched. Never throws.
 */
export async function disconnectCodexGlobalMcps(deps: SyncDeps = {}): Promise<void> {
  const { cli, manifest, codexHome } = resolve(deps);

  try {
    const managed = manifest.readManagedNames(codexHome);
    for (const name of managed) {
      await cli.mcpRemove(name, { codexHome });
    }
    manifest.writeManagedNames(codexHome, new Set());
  } catch (err) {
    logger.warn(
      { err, tag: "codex-config", op: "disconnect_error" },
      "disconnectCodexGlobalMcps failed",
    );
  }
}

/**
 * Guarded entry point called from the config-writer seams. DOUBLE-GATED:
 * performs ZERO cli / manifest-write calls unless the user is connected AND this
 * is the canonical libi instance. Otherwise it is a strict no-op. Never throws.
 */
export async function syncCodexGlobalMcpsIfConnected(
  deps: SyncDeps = {},
): Promise<void> {
  try {
    const { isCanonical } = resolve(deps);
    if (!getCodexConnectSetting().connected) return;
    if (!isCanonical()) return;
    await syncCodexGlobalMcps(deps);
  } catch (err) {
    logger.warn(
      { err, tag: "codex-config", op: "sync_if_connected_error" },
      "syncCodexGlobalMcpsIfConnected failed",
    );
  }
}

/** Persist lastSyncStatus, preserving the current `connected` flag. Never throws. */
function persistStatus(status: "ok" | "error"): void {
  try {
    const cur = getCodexConnectSetting();
    setCodexConnectSetting({ connected: cur.connected, lastSyncStatus: status });
  } catch (err) {
    logger.warn(
      { err, tag: "codex-config", op: "persist_status_error" },
      "failed to persist codex sync status",
    );
  }
}
