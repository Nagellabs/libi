/**
 * The login-shell PATH cache written by `electron/path-bootstrap.ts`.
 *
 * A GUI-launched Electron app inherits a minimal PATH — not the one the user's
 * shell profile builds. `path-bootstrap.ts` resolves the real login-shell PATH
 * once at startup and caches it at `<LIBI_HOME>/shell-path-cache.json`; this is
 * the reader every consumer shares.
 *
 * **Never re-probe the login shell to refresh this.** `path-bootstrap.ts`
 * documents a packaged boot that hung for 10+ minutes inside a TCC-blocked
 * `/bin/zsh` which no timeout could kill. Reading the cache is free; respawning
 * the shell is not, and has already cost a hang in the field.
 *
 * A cache written under a different `$SHELL` is still better evidence about the
 * user's environment than this process's own PATH, so it is read leniently and
 * an absent/corrupt cache degrades to an empty list rather than throwing.
 */

import fs from "fs";
import path from "path";
import { getLibiHome } from "@/lib/libi-home";
import { isWindows } from "@/lib/platform";

/** PATH list separator for this platform. */
export function pathSeparator(): string {
  return isWindows() ? ";" : ":";
}

/**
 * PATH entries from the login-shell cache, or `[]` when there is none.
 *
 * Absent is normal, not an error: only the Electron shell writes this file, so
 * an `npx @nagellabs/libi` run has no cache at all. In that case the process's
 * OWN PATH is the honest source — the user launched it from their shell.
 */
export function cachedShellPathDirs(): string[] {
  try {
    const raw = fs.readFileSync(
      path.join(getLibiHome(), "shell-path-cache.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { path?: unknown };
    if (typeof parsed.path !== "string") return [];
    return parsed.path.split(pathSeparator()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Directories a user-invoked command would be searched in, most-honest source
 * first: the login-shell cache (what the user's own terminal sees), then this
 * process's PATH as a fallback.
 */
export function userCommandSearchDirs(): string[] {
  const own = (process.env.PATH ?? "").split(pathSeparator()).filter(Boolean);
  return [...cachedShellPathDirs(), ...own];
}
