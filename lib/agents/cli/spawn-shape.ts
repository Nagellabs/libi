import fs from "fs";
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
    if (js) return { command: resolveNodeCommand(), args: [js] };
  }
  return { command: binPath, args: [] };
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
