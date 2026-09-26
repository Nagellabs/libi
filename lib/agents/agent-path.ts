/**
 * The PATH libi hands the agents it starts, and the PATH each running agent process got.
 *
 * An agent's child takes libi's environment as it was when libi booted. A launcher the user installs later
 * (`uv`, so `uvx`; a new Node, so `npx`) lands on their login-shell PATH, which the CLI resolver's probe reads
 * fresh (`lastLoginShellPathDirs`), and the Providers tab then reads that launcher as found. The agent process,
 * started with the boot PATH, still can't run it, so an MCP server launched with it never starts. So:
 *
 *   - a new agent process (`lib/agents/process-manager.ts`), including the replacement a chat's Restart session
 *     can make, gets this process's PATH followed by every login-shell folder it lacks (`agentChildPath`);
 *   - a new Claude Code chat gets the same PATH through its session options (`lib/sessions/session-meta.ts`),
 *     because claude-agent-acp starts a `claude` per chat with the environment it is handed, so a chat opened on
 *     an adapter that predates the launcher still finds it; a pre-created chat made before the PATH grew is
 *     discarded (`lib/sessions/standby-freshness.ts`);
 *   - Codex reads its MCP servers in one `codex app-server` per adapter process, so a running Codex process
 *     keeps its PATH. Detection compares a found launcher against the PATH that process got
 *     (`agentSpawnPathDirs`) and says when it can't see it (`lib/providers/detect.ts`).
 *
 * The login-shell folders go AFTER this process's own, so nothing that resolved before resolves differently.
 * Nothing here spawns a shell: the login-shell PATH is the last one the resolver's probe delivered, and there
 * is none on Windows, where nothing changes.
 */
import path from "node:path";
import { lastLoginShellPathDirs } from "@/lib/agents/cli/login-shell-path";

/**
 * `env.PATH` followed by each login-shell folder it doesn't already hold, in the login shell's order. `env.PATH`
 * as it is (possibly undefined) when there is no login-shell PATH or it adds nothing.
 */
export function agentChildPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  loginDirs: readonly string[] | null = lastLoginShellPathDirs(),
  delimiter: string = path.delimiter,
): string | undefined {
  const current = env.PATH;
  if (!loginDirs || loginDirs.length === 0) return current;
  const own = (current ?? "").split(delimiter).filter(Boolean);
  const seen = new Set(own);
  const added: string[] = [];
  for (const dir of loginDirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    added.push(dir);
  }
  return added.length === 0 ? current : [...own, ...added].join(delimiter);
}

const g = globalThis as unknown as { __libiAgentSpawnPaths?: Map<string, string[]> };

function spawnPaths(): Map<string, string[]> {
  g.__libiAgentSpawnPaths ??= new Map();
  return g.__libiAgentSpawnPaths;
}

/** The process manager started `agentId`'s current process with `pathValue`. */
export function recordAgentSpawnPath(agentId: string, pathValue: string | undefined, delimiter: string = path.delimiter): void {
  spawnPaths().set(agentId, (pathValue ?? "").split(delimiter).filter(Boolean));
}

/** `agentId` has no current process any more. */
export function forgetAgentSpawnPath(agentId: string): void {
  spawnPaths().delete(agentId);
}

/** The PATH folders `agentId`'s running process was started with, or null when none is running. */
export function agentSpawnPathDirs(agentId: string): string[] | null {
  return spawnPaths().get(agentId) ?? null;
}

/** Tests only. */
export function __resetAgentSpawnPaths(): void {
  g.__libiAgentSpawnPaths = undefined;
}
