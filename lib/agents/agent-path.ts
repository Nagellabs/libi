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
 * Nothing here spawns a shell: the login-shell PATH is the last one the resolver's probe delivered.
 *
 * Windows has no login shell. There the fresh PATH is the registry's (`lib/agents/cli/windows-registry-path.ts`:
 * the machine's `Path`, then the user's, `%VAR%` expanded), which an installer writes and a running process never
 * sees. `refreshFreshPathDirs()` reads it (bounded 2 s) before an agent process is spawned and before a chat's
 * session is created; everything else reads the last good read, never waiting. A read that fails or times out
 * leaves the PATH as it was. The inherited key there is `Path`, so the PATH is read and written under the key the
 * environment already has (`pathEnvKey`).
 */
import { lastLoginShellPathDirs } from "@/lib/agents/cli/login-shell-path";
import { lastWindowsRegistryPathDirs, refreshWindowsRegistryPath } from "@/lib/agents/cli/windows-registry-path";
import { isWindows } from "@/lib/platform";

/** The PATH folders a process started now would get that this one may lack: the login shell's, or on Windows the registry's. */
export function freshPathDirs(): string[] | null {
  return isWindows() ? lastWindowsRegistryPathDirs() : lastLoginShellPathDirs();
}

/** Re-read the fresh PATH where reading it has to be asked for: the registry on Windows (bounded, never rejects). Null
 *  elsewhere — the login-shell PATH is refreshed by the CLI resolver's probe — so a caller awaits only when there is
 *  something to wait on (`const r = refreshFreshPathDirs(); if (r) await r;`) and adds no turn off Windows. */
export function refreshFreshPathDirs(): Promise<unknown> | null {
  return isWindows() ? refreshWindowsRegistryPath() : null;
}

/** This platform's PATH separator, decided at call time (so a test that pins the platform reads Windows' `;`). */
export function pathDelimiter(): string {
  return isWindows() ? ";" : ":";
}

/** The key `env` holds its PATH under: on Windows whatever spelling it has (`Path`, usually), else `PATH`. */
export function pathEnvKey(env: Readonly<Record<string, string | undefined>>): string {
  if (!isWindows()) return "PATH";
  return Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "Path";
}

/**
 * `env`'s PATH followed by each fresh folder it doesn't already hold, in the fresh PATH's order. `env`'s PATH as it is
 * (possibly undefined) when there is no fresh PATH or it adds nothing. Windows compares folders case-insensitively.
 */
export function agentChildPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  loginDirs: readonly string[] | null = freshPathDirs(),
  delimiter: string = pathDelimiter(),
): string | undefined {
  const current = env[pathEnvKey(env)];
  if (!loginDirs || loginDirs.length === 0) return current;
  const own = (current ?? "").split(delimiter).filter(Boolean);
  const norm = isWindows() ? (d: string) => d.replace(/[\\/]+$/, "").toLowerCase() : (d: string) => d;
  const seen = new Set(own.map(norm));
  const added: string[] = [];
  for (const dir of loginDirs) {
    if (!dir || seen.has(norm(dir))) continue;
    seen.add(norm(dir));
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
export function recordAgentSpawnPath(agentId: string, pathValue: string | undefined, delimiter: string = pathDelimiter()): void {
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
