/**
 * "Does the user have this CLI?" — for terminal presets only.
 *
 * ── Read this before reusing it ───────────────────────────────────────────
 * AGENTS.md is emphatic that AGENT AVAILABILITY is never decided by
 * `which claude` / `which codex`: libi installs its own CLIs and puts nothing
 * on PATH, so a PATH probe reports working installs as broken. That rule
 * stands, and nothing here may ever feed `lib/agents/agent-readiness.ts`.
 *
 * The terminal preset asks a genuinely different question. It TYPES a bare
 * `claude` into the user's login shell, so what matters is exactly "would the
 * user's own shell find this name" — the same question
 * `lib/codex-config/codex-cli.ts#userCodexCli` asks, and it is answered the
 * same way: from the login-shell PATH cache, never by spawning a shell.
 *
 * ── This is evidence, not proof ───────────────────────────────────────────
 * The PTY runs a LOGIN shell (`lib/terminal/pty.ts#resolveShell` passes `-l`),
 * so its profile could add a directory that is in neither the cache nor this
 * process's PATH. A false "missing" is therefore possible. That is acceptable
 * ONLY because of how the caller degrades: it types a shell COMMENT carrying
 * the install hint instead of the command, and the user keeps a live shell in
 * which they can simply type `claude` themselves. A wrong answer costs one
 * comment line; it never blocks anything.
 */

import fs from "fs";
import path from "path";
import { userCommandSearchDirs } from "@/lib/shell-path-cache";

/**
 * Names a bare `<command>` could resolve to on this platform.
 *
 * Windows resolves a bare name through PATHEXT, so `claude` may be installed
 * as `claude.cmd` (the usual shape for an npm global bin) or `claude.exe`.
 * Checking only the extensionless name would report every npm-installed CLI on
 * Windows as missing.
 */
function candidateNames(command: string): string[] {
  if (process.platform !== "win32") return [command];
  return [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command];
}

function isExecutableFile(candidate: string): boolean {
  try {
    const st = fs.statSync(candidate);
    if (!st.isFile()) return false;
    // Windows has no execute bit; presence in PATH with a PATHEXT suffix is
    // the whole test there.
    if (process.platform === "win32") return true;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a terminal preset's command to an executable the user's shell would
 * find, or `null` when there is no evidence of one.
 *
 * `searchDirs` is injectable so tests can bound the search to a fixture tree
 * rather than whatever the host machine happens to have installed.
 */
export function resolveUserCli(
  command: string,
  searchDirs: string[] = userCommandSearchDirs(),
): string | null {
  // An absolute or explicitly-relative command is not a PATH lookup at all.
  if (command.includes("/") || command.includes("\\")) {
    return isExecutableFile(command) ? command : null;
  }
  for (const dir of searchDirs) {
    for (const name of candidateNames(command)) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}
