import fs from "fs";
import os from "os";
import path from "path";

import { resolveNodeCommand } from "@/lib/runtime/node-runtime";

/**
 * How to spawn a resolved executable: through node when it is a script, as-is
 * when it is a native launcher. Shared by the ACP adapter spawn
 * (`lib/agents/acp/agent-registry.ts`) and the user-CLI resolver
 * (`lib/agents/cli/resolve.ts`).
 *
 * Bare `fs` / `path` imports on purpose: tests mock `"fs"` to control
 * `realpathSync` for the adapter spawn.
 */
export type ResolvedBin = { command: string; args: string[] };

/**
 * `node_modules/.bin/claude-agent-acp` is a symlink to a `#!/usr/bin/env node`
 * script, so spawning it directly requires `node` on the PATH of the SPAWNING
 * process — which, in a Finder-launched packaged app whose login-shell PATH
 * probe timed out, it is not (see `lib/runtime/node-runtime.ts`). Resolve the
 * link and run it through `resolveNodeCommand()` instead, so the adapter
 * launches off an absolute interpreter path rather than a shebang lookup.
 *
 * A Windows `.cmd` shim gets the SAME treatment, via its own JS target: since
 * the CVE-2024-27980 fix (Node ≥18.20.2 / ≥20.12.0) `child_process.spawn()`
 * REFUSES a `.cmd`/`.bat` file with `EINVAL` unless `shell: true`. Handing one
 * back unchanged here therefore produced an adapter that could never launch on
 * Windows while detection cheerfully reported it installed.
 *
 * `shell: true` is deliberately NOT the fix: it is the very thing the CVE was
 * about, and it re-introduces quoting hazards on any path containing a space —
 * `C:\Users\First Last\…` is the common case, not an edge one. Reading the
 * shim's own target and running it through `resolveNodeCommand()` keeps one
 * mechanism for all three platforms.
 *
 * Anything that resolves to neither (a genuine native launcher) is spawned
 * unchanged — those need no interpreter, and handing them to node would break
 * them.
 */
export function spawnViaNodeIfScript(
  binPath: string,
  realpath: (p: string) => string = fs.realpathSync,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf-8"),
  exists: (p: string) => boolean = fs.existsSync,
): ResolvedBin {
  let target = binPath;
  try {
    target = realpath(binPath);
  } catch {
    /* not a link / unreadable — fall through with the original path */
  }
  if (/\.(c|m)?js$/.test(target)) {
    return { command: resolveNodeCommand(), args: [target] };
  }
  if (/\.cmd$/i.test(target)) {
    const js = resolveCmdShimTarget(target, readFile);
    if (js) return { command: nodeForCmdShim(target, exists), args: [js] };
  }
  return { command: binPath, args: [] };
}

/**
 * npm's own JS shim probes `"%dp0%\node.exe"` (`%dp0%` is the shim's own directory) and only falls back to a bare
 * `node` when that is absent — nvm-windows and Volta both place a `node.exe` beside a shim they manage. Always
 * running libi's OWN managed node here instead skipped that sibling entirely, so the adapter/CLI launched under a
 * Node version the shim itself would never have chosen.
 */
function nodeForCmdShim(cmdPath: string, exists: (p: string) => boolean): string {
  const sibling = path.win32.join(path.win32.dirname(cmdPath), "node.exe");
  return exists(sibling) ? sibling : resolveNodeCommand();
}

/**
 * The JS file an npm-generated `.cmd` shim actually runs, or null.
 *
 * npm's cmd-shim writes the target as `"%dp0%\..\<pkg>\<entry>.js"`, where
 * `%dp0%` is the shim's own directory. Anything that does not match that shape
 * (a hand-written batch file, a shim format npm may change) returns null and
 * the caller falls back to spawning the shim as-is — no worse than before.
 */
export function resolveCmdShimTarget(
  cmdPath: string,
  readFile: (p: string) => string,
): string | null {
  let text: string;
  try {
    text = readFile(cmdPath);
  } catch {
    return null;
  }
  const m = /%dp0%\\(.+?\.(?:c|m)?js)"/i.exec(text);
  if (!m) return null;
  return path.resolve(path.dirname(cmdPath), m[1].replace(/\\/g, path.sep));
}

/**
 * The NATIVE `.exe` an npm-generated `.cmd` shim runs, or null. claude-code
 * ≥ 2.1.267 ships `bin\claude.exe` and no `cli.js`, and npm's cmd-shim writes
 * `"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*` for it
 * (as read from a real Windows install). The target must contain a folder, so
 * a JS shim's own `IF EXIST "%dp0%\node.exe"` probe never matches. Windows path
 * rules on every host: this only ever describes a win32 shim, and the unit tests
 * run on macOS / ubuntu.
 */
export function resolveCmdShimNativeTarget(cmdPath: string, readFile: (p: string) => string): string | null {
  let text: string;
  try {
    text = readFile(cmdPath);
  } catch {
    return null;
  }
  const m = /"%dp0%\\([^"]*\\[^"\\]+\.exe)"/i.exec(text);
  if (!m) return null;
  return path.win32.resolve(path.win32.dirname(cmdPath), m[1]);
}

/**
 * How a Windows setup terminal runs the user's CLI without going through its npm
 * `.cmd` shim, or null when there is no shim to skip (not Windows, not a `.cmd`,
 * or a shim whose target can't be read).
 *
 * A PowerShell line that calls `claude.cmd` runs it in `cmd.exe`, and Ctrl-C
 * there — a sign-in the user cancels — stops at cmd's own
 * `Terminate batch job (Y/N)?` before anything else happens (2026-09-25 Windows
 * run). Running what the shim runs instead has no batch file to ask about: its
 * JS target through node (`spawnViaNodeIfScript`'s shape, same node), or its
 * native `.exe` target directly (claude-code ≥ 2.1.267 ships one). The printed
 * command still names a real file of the user's own install; nothing is written.
 */
export function terminalLaunchFor(
  realPath: string,
  deps: {
    platform?: NodeJS.Platform;
    readFile?: (p: string) => string;
    nodeCommand?: () => string;
    exists?: (p: string) => boolean;
  } = {},
): ResolvedBin | null {
  // `os.platform()`, a call the Next build can't fold against the build machine (lib/platform.ts).
  const platform = deps.platform ?? os.platform();
  if (platform !== "win32" || !/\.cmd$/i.test(realPath)) return null;
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, "utf-8"));
  const exists = deps.exists ?? fs.existsSync;
  const js = resolveCmdShimTarget(realPath, readFile);
  if (js) {
    const sibling = path.win32.join(path.win32.dirname(realPath), "node.exe");
    return { command: exists(sibling) ? sibling : (deps.nodeCommand ?? resolveNodeCommand)(), args: [js] };
  }
  const exe = resolveCmdShimNativeTarget(realPath, readFile);
  if (exe) return { command: exe, args: [] };
  return null;
}
