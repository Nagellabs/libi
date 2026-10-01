/**
 * Can the launch command of a local (stdio) MCP server be found on this
 * computer? Provider detection (`./detect.ts`) asks this for every stdio entry
 * it reads, so an entry whose launcher is missing reads "can't start" instead of
 * "connected". Found live: a `claude mcp add … -- uvx elevenlabs-mcp` entry on a
 * Mac without uv read Connected, while Claude Code logged `Executable not found
 * in $PATH: uvx` and the chat had no ElevenLabs tools.
 *
 * Detection is polled every few seconds while a setup terminal is open, so this
 * NEVER spawns: no shell, no `which`, no `--version`. It stats files in a
 * folder list only.
 *
 * - An absolute command is found when that file exists and is executable
 *   (Windows: exists, trying PATHEXT extensions when it has none of them).
 * - A bare name is searched on the login-shell PATH libi already knows (the
 *   last one `resolveAgentCli`'s probe delivered, and the desktop shell's
 *   `shell-path-cache.json`), then this process's PATH. Windows honours PATHEXT
 *   and has no login shell: there the fresh PATH is the registry's (the last
 *   read of `lib/agents/cli/windows-registry-path.ts`, which a detection pass
 *   refreshes first), the one a new agent process and a new chat get
 *   (`lib/agents/agent-path.ts`), then this process's PATH.
 * - The CLI resolver's known install folders (`knownInstallDirs`: `~/.local/bin`
 *   and friends) are deliberately NOT searched. The agent that launches the
 *   server gets a PATH, not those folders: the in-app ACP child inherits this
 *   process's env (`lib/agents/process-manager.ts`), whose PATH is the login
 *   shell's over a fallback without `~/.local/bin` (`electron/path-bootstrap.ts`),
 *   and the user's own CLI has its shell's PATH. A launcher found only in such a
 *   folder (uv's default `~/.local/bin` with `UV_NO_MODIFY_PATH`) is exactly the
 *   one that fails with "Executable not found in $PATH" — counting it would hide
 *   the failure this lookup exists to show.
 * - `unknown` whenever the answer would be a guess: a bare name that is not on
 *   any folder while no login-shell PATH is known yet (the desktop app's own
 *   PATH is launchd's, not the user's), a relative path (it depends on the
 *   agent's working folder), or a command the agent expands itself (`$VAR`,
 *   `${VAR}`, `%VAR%`, `~`). Unknown is not broken: detection leaves such a row
 *   exactly as it was.
 */
import fs from "node:fs";
import path from "node:path";
import { lastLoginShellPathDirs } from "@/lib/agents/cli/login-shell-path";
import { lastWindowsRegistryPathDirs } from "@/lib/agents/cli/windows-registry-path";
import { cachedShellPathDirs } from "@/lib/shell-path-cache";

export type LauncherLookup = "found" | "missing" | "unknown";

export interface LauncherDeps {
  platform?: NodeJS.Platform;
  /** The PATH a process started now would get: the user's login-shell PATH, or on Windows the registry's; null
   *  while none is known. */
  loginShellDirs?: () => string[] | null;
  processPathDirs?: () => string[];
  isExecutable?: (p: string) => boolean;
  /** Windows only. Default: `process.env.PATHEXT`, else Windows' own default list. */
  pathExt?: string;
}

const WINDOWS_DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** What the agent would expand before running it: libi can't, so it doesn't guess. */
const EXPANDED = /[$%]|^~/;

function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** The command as the user reads it: the bare name only, never a folder. */
export function launcherName(command: string, platform: NodeJS.Platform = process.platform): string {
  return pathFor(platform).basename(command.trim());
}

/** Both login-shell sources libi already has, without spawning; null when neither has a PATH. On Windows, the
 *  registry's PATH as last read (never read here). */
function defaultLoginShellDirs(platform: NodeJS.Platform): string[] | null {
  if (platform === "win32") return lastWindowsRegistryPathDirs();
  const dirs = [...(lastLoginShellPathDirs() ?? []), ...cachedShellPathDirs()];
  return dirs.length > 0 ? dirs : null;
}

function defaultIsExecutable(platform: NodeJS.Platform): (p: string) => boolean {
  return (p) => {
    try {
      if (!fs.statSync(p).isFile()) return false;
      // X_OK is only an existence check on Windows.
      if (platform !== "win32") fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

/** The spellings Windows would run for `file`: as written when it already carries a PATHEXT extension, else with each one. */
function windowsSpellings(file: string, pathExt: string): string[] {
  const exts = pathExt.split(";").map((e) => e.trim()).filter(Boolean);
  const ext = path.win32.extname(file).toLowerCase();
  if (ext && exts.some((e) => e.toLowerCase() === ext)) return [file];
  return exts.map((e) => file + e);
}

/**
 * One lookup per detection pass: the login-shell PATH (the resolver's memory
 * plus the shell-path cache FILE) is read once, on first use, and reused for
 * every row of the pass — not re-read per stdio row. First use, not creation:
 * detection resolves codex (which may run the login-shell probe) before it
 * checks any row.
 */
export function launcherLookupForPass(deps: LauncherDeps = {}): (command: string) => LauncherLookup {
  let login: string[] | null | undefined;
  const loginShellDirs = (): string[] | null => {
    if (login === undefined) login = deps.loginShellDirs ? deps.loginShellDirs() : defaultLoginShellDirs(deps.platform ?? process.platform);
    return login;
  };
  return (command) => lookupLauncher(command, { ...deps, loginShellDirs });
}

export function lookupLauncher(command: string, deps: LauncherDeps = {}): LauncherLookup {
  const platform = deps.platform ?? process.platform;
  const p = pathFor(platform);
  const cmd = typeof command === "string" ? command.trim() : "";
  if (!cmd || EXPANDED.test(cmd)) return "unknown";

  const isExecutable = deps.isExecutable ?? defaultIsExecutable(platform);
  const spellings = (file: string): string[] =>
    platform === "win32" ? windowsSpellings(file, deps.pathExt ?? process.env.PATHEXT ?? WINDOWS_DEFAULT_PATHEXT) : [file];
  const exists = (file: string): boolean => spellings(file).some((s) => isExecutable(s));

  if (p.isAbsolute(cmd)) return exists(cmd) ? "found" : "missing";
  // `bin/server`, `./server.sh`: relative to the agent's working folder, which libi doesn't know.
  if (cmd.includes("/") || (platform === "win32" && cmd.includes("\\"))) return "unknown";

  const login = deps.loginShellDirs ? deps.loginShellDirs() : defaultLoginShellDirs(platform);
  const own = (deps.processPathDirs ?? (() => (process.env.PATH ?? "").split(p.delimiter).filter(Boolean)))();
  for (const dir of [...(login ?? []), ...own]) {
    if (dir && exists(p.join(dir, cmd))) return "found";
  }
  // Windows: the registry and this process's PATH are the whole answer — nothing to wait for.
  return platform === "win32" || login !== null ? "missing" : "unknown";
}
