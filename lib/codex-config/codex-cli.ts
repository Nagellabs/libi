/**
 * Read-only wrapper around the user's `codex mcp list --json`.
 *
 * libi never runs `codex mcp add`/`remove` from the server: those are
 * printed for the user by `lib/agents/setup/commands.ts` and submitted in a
 * setup terminal. The one writer left in libi is the `libi connect` CLI
 * (`lib/cli/connect.ts`), which the user runs from their own terminal.
 *
 * The child's `CODEX_HOME` is injected from `resolveCodexHome()` (or an
 * explicit override), so a worktree / dev / test instance reads its own home.
 * Every call swallows errors — it NEVER throws — and has a 2 s default timeout.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import fs from "node:fs";
import { resolveCodexHome } from "./canonical";
import { serverLogger as logger } from "@/lib/logger";
import { LIBI_MCP_ENTRY_NAME } from "@/lib/mcp/agent-surface";

const execFileAsync = promisify(execFile);

const CODEX_BIN = "codex";
const TIMEOUT_MS = 2000;

/**
 * Injectable spawner (default: real `execFile`). Tests inject a fake that
 * records argv + env and NEVER spawns real codex.
 */
export type CodexSpawner = (
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultSpawner: CodexSpawner = (file, args, opts) =>
  // windowsHide: the Next server runs inside Electron's console-less main
  // process on Windows, so a console child gets a fresh Windows Terminal
  // window unless this is set — see lib/agents/process-manager.ts.
  execFileAsync(file, args, { ...opts, windowsHide: true });

export interface CodexCliOpts {
  /** Override the spawner (tests). Defaults to a real `execFile`. */
  spawner?: CodexSpawner;
  /** Override CODEX_HOME injected into the child env. Defaults to resolveCodexHome(). */
  codexHome?: string;
  /**
   * The codex executable to invoke — normally the exact path the CLI resolver
   * (`lib/agents/cli/resolve.ts`) found. Defaults to the bare name `codex`,
   * re-resolved against the child's PATH.
   *
   * Pass it whenever you have already resolved one. The bare name is resolved
   * against THIS PROCESS's PATH, which is neither where the probe looked (the
   * login-shell cache can name a binary a Finder-launched server can't see →
   * ENOENT) nor necessarily the same binary (npm's `node_modules/.bin` prefix
   * shadows a real user install → the wrong codex). Naming the binary removes
   * both gaps; it does NOT change which config is read — that is `codexHome`,
   * injected as CODEX_HOME below, independently of which executable runs.
   */
  bin?: string;
  /**
   * Arguments placed before the `mcp …` subcommand — for a codex that must run
   * through an interpreter (`bin` = node, `binArgs` = [the script]), the shape
   * `spawnViaNodeIfScript` gives. Default none.
   */
  binArgs?: string[];
  /** Spawn timeout. Defaults to TIMEOUT_MS (2 s); the listing libi's registration check and provider detection share passes 15 s (`lib/agents/codex-mcp-listing.ts`). */
  timeoutMs?: number;
}

/** Build the child env with CODEX_HOME injected. */
function childEnv(codexHome: string): NodeJS.ProcessEnv {
  return { ...process.env, CODEX_HOME: codexHome };
}

/** Pull a readable stderr out of whatever the spawner threw. */
function errStderr(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { stderr?: unknown; message?: unknown };
    if (typeof e.stderr === "string" && e.stderr.trim()) return e.stderr;
    if (typeof e.message === "string") return e.message;
  }
  return String(err);
}

/** One entry as `codex mcp list --json` prints it (verified codex-cli 0.148.0,
 *  2026-09-09; absent fields print as `null`, so every optional is read with a
 *  type check, never a presence check). Names only — libi never reads a value
 *  out of `env`, only its keys, and `bearer_token_env_var` is a variable NAME. */
export interface CodexMcpListEntry {
  name: string;
  enabled: boolean;
  transport: {
    type: string;
    command?: string;
    url?: string;
    env?: Record<string, string> | null;
    env_vars?: string[] | null;
    bearer_token_env_var?: string | null;
  };
  auth_status?: string;
}

/**
 * What the user's own `[mcp_servers.libi]` looks like to CODEX — the answer to
 * "why does this in-app Codex chat have no libi tools?".
 *
 *  - `absent`   — no entry of that name. The ACP override stands alone; normal
 *                 for a machine that never ran `libi connect`.
 *  - `http`     — the shape libi itself writes. The override replaces it
 *                 field-by-field and everything works.
 *  - `disabled` — `enabled = false`, which SURVIVES the merge, so the in-app
 *                 session mounts no libi at all and nothing fails. This is the
 *                 silent half of the edge on
 *                 `lib/mcp/agent-surface.ts#LIBI_MCP_ENTRY_NAME`.
 *  - `stdio`    — a hand-written `command = …` entry. Merging the override's
 *                 `url` into it makes codex reject the whole config, so the
 *                 session cannot start; the session manager retries under
 *                 `LIBI_MCP_FALLBACK_ENTRY_NAME`.
 *  - `unknown`  — codex was not runnable or printed something unparseable.
 *                 NEVER treat this as "fine": it is no information.
 *
 * This is a DIAGNOSTIC, never a gate. It exists to put a cause in
 * `~/.libi/logs/libi.log` next to a symptom the user would otherwise
 * experience as "libi's tools just aren't there", and callers must behave
 * identically whatever it returns. That is also why it is not the TOML sniffer
 * `LIBI_MCP_ENTRY_NAME` rejects: nothing here parses the user's file — codex
 * reads its own config and reports `enabled` / `transport.type` itself, so a
 * shape libi has never seen is codex's problem to classify, and a wrong answer
 * costs one log line rather than a broken session.
 *
 * `entries` is codex's own listing, `null` when it gave none. Session start
 * reads it through the listing libi's other Codex readers share
 * (`readLibiCodexEntryShape` in `lib/agents/libi-registration.ts`), never a
 * spawn of its own.
 */
export type LibiCodexEntryShape = "absent" | "http" | "disabled" | "stdio" | "unknown";

export function libiCodexEntryShape(entries: CodexMcpListEntry[] | null): LibiCodexEntryShape {
  if (!Array.isArray(entries)) return "unknown";
  const entry = entries.find(
    (e) => e && typeof e === "object" && e.name === LIBI_MCP_ENTRY_NAME,
  );
  if (!entry) return "absent";
  if (entry.enabled === false) return "disabled";
  return entry.transport?.type === "stdio" ? "stdio" : "http";
}

/**
 * `codex mcp list --json`, parsed. Returns null when codex isn't runnable or
 * the output isn't the expected array — the caller treats null as
 * "no information", never as "nothing configured". A missing codex home is
 * "nothing configured" (`[]`): codex errors on a missing CODEX_HOME instead
 * of reporting empty.
 */
export async function mcpListJson(opts: CodexCliOpts = {}): Promise<CodexMcpListEntry[] | null> {
  // A non-existent codex home means nothing is configured yet — and codex
  // itself ERRORS on a missing CODEX_HOME rather than reporting empty.
  const home = opts.codexHome ?? resolveCodexHome();
  if (!fs.existsSync(home)) return [];
  // The argv is fixed HERE rather than taken as a parameter, so this module
  // has no way to run anything but a list.
  const spawner = opts.spawner ?? defaultSpawner;
  let stdout: string;
  try {
    const args = [...(opts.binArgs ?? []), "mcp", "list", "--json"];
    ({ stdout } = await spawner(opts.bin ?? CODEX_BIN, args, {
      env: childEnv(home),
      timeout: opts.timeoutMs ?? TIMEOUT_MS,
    }));
  } catch (err) {
    logger.warn({ tag: "codex-config", op: "list", err: errStderr(err) }, "codex mcp list failed");
    return null;
  }
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) ? (parsed as CodexMcpListEntry[]) : null;
  } catch {
    return null;
  }
}
