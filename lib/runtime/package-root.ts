/**
 * Where is libi's own package root, from any module inside it?
 *
 * Several modules resolve package-relative data files (`mcp/whisper/*.py`,
 * `mcp/templates/instructions.md`, the `projectRoot` the production server
 * chdirs to) from their OWN `__dirname` rather than `process.cwd()` — cwd is
 * the user's launch directory under `npx @nagellabs/libi`, and the agent
 * workspace (`~/.libi/agent/`) for the MCP child, so it cannot be trusted.
 *
 * Hardcoding the hop count (`path.resolve(__dirname, "..", "..")`) makes that
 * arithmetic depend on where the module physically sits — which is no longer
 * a constant: `scripts/build-cli.js` emits a compiled mirror of `lib/` and
 * `mcp/` under `dist-cli/`, one level deeper than the source tree, for the
 * npm-installed run mode (see that script's header for why compiling is
 * required at all). A `../..` that is right in dev is off by one there.
 *
 * Walking up to the nearest `package.json` is depth-independent and correct in
 * every run mode: dev checkout, compiled `dist-cli/`, packaged Electron
 * (`Contents/Resources/app/`), and an installed
 * `node_modules/@nagellabs/libi/`. There is no `package.json` inside
 * `dist-cli/`, `lib/` or `mcp/`, so the first hit is always the real root.
 */

import fs from "node:fs";
import path from "node:path";

/** Max ancestors to inspect. Deep enough for any real layout, bounded so a
 *  pathological path can't spin. */
const MAX_DEPTH = 12;

/**
 * Nearest ancestor of `fromDir` (inclusive) containing a `package.json`, or
 * `null` when there is none.
 *
 * Returns null — rather than guessing — under a Turbopack-bundled build,
 * where `__dirname` is the build-time placeholder `/ROOT/...` that does not
 * exist at runtime. Callers pick their own fallback for that case.
 */
export function findPackageRoot(fromDir: string): string | null {
  let dir = fromDir;
  for (let i = 0; i < MAX_DEPTH; i++) {
    try {
      if (fs.statSync(path.join(dir, "package.json")).isFile()) return dir;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * libi's package root, falling back to `process.cwd()` when the walk finds
 * nothing (the Turbopack-bundled case — both entry points normalise cwd to the
 * app root before anything reaches here).
 */
export function packageRoot(fromDir: string = __dirname): string {
  return findPackageRoot(fromDir) ?? process.cwd();
}
