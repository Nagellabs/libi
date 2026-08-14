/**
 * Dual-mode resolution for the child processes libi spawns from its own tree
 * (the core MCP server, the standalone tracking MCP).
 *
 * ## The two modes
 *
 * **Source + tsx** — a dev checkout and the packaged Electron app both run
 * libi's `.ts` directly through tsx. Nothing here changes that.
 *
 * **Compiled** — an `npm install` / `npx @nagellabs/libi` copy CANNOT. tsx
 * applies the tsconfig `paths` matcher only when the importing file's own path
 * has no `node_modules` segment (verified in `node_modules/tsx/dist/register-*.cjs`),
 * and an installed package is entirely under one — so every `@/…` import
 * throws MODULE_NOT_FOUND before a single line of libi runs. The packaged
 * Electron app is only exempt by accident of layout (`Contents/Resources/app/`
 * has no such segment), which is why this stayed invisible.
 * `scripts/build-cli.js` pre-resolves those specifiers into `dist-cli/`; this
 * module is what points the spawns at it.
 *
 * ## Why the switch is "am I under node_modules", not "does dist-cli exist"
 *
 * Preferring the compiled tree whenever it happens to be present would mean a
 * dev who once ran `npm run build:cli` silently starts debugging STALE
 * compiled JS instead of their working tree — the drift trap. The
 * node_modules test is the exact condition that breaks tsx, so it selects
 * compiled output precisely when source cannot work, and never otherwise.
 */

import fs from "fs";
import path from "path";
import { resolveNodeCommand } from "@/lib/runtime/node-runtime";

/** Directory holding the compiled mirror, relative to the package root. */
export const COMPILED_DIR = "dist-cli";

/**
 * True when this copy of libi lives under a `node_modules` directory — i.e.
 * it was installed as a dependency, and tsx will refuse to resolve its `@/…`
 * imports.
 */
export function isInstalledUnderNodeModules(root: string): boolean {
  return root.split(path.sep).includes("node_modules");
}

/** `mcp/index.ts` → `<root>/dist-cli/mcp/index.js`. */
export function compiledEntryPath(root: string, sourceRel: string): string {
  return path.join(root, COMPILED_DIR, sourceRel.replace(/\.tsx?$/, ".js"));
}

export interface ResolvedEntrySpawn {
  command: string;
  args: string[];
  mode: "tsx" | "compiled";
}

/**
 * Resolve how to spawn one of libi's own entry points, or `null` when neither
 * mode is available (callers throw their own diagnostic — the two call sites
 * word it differently and both messages are load-bearing).
 *
 * `sourceRel` is the entry's path relative to the package root, e.g.
 * `mcp/index.ts`.
 *
 * `command` is `resolveNodeCommand()` in both modes — never `process.execPath`:
 * under Electron `electronFuses.runAsNode: false` makes the packaged binary
 * ignore `ELECTRON_RUN_AS_NODE`, so spawning it launches a second full Libi
 * GUI instead of a Node child.
 */
export function resolveEntrySpawn(
  projectRoot: string,
  sourceRel: string,
): ResolvedEntrySpawn | null {
  const entryPoint = path.join(projectRoot, sourceRel);
  const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");

  if (
    !isInstalledUnderNodeModules(projectRoot) &&
    fs.existsSync(entryPoint) &&
    fs.existsSync(tsxCli)
  ) {
    return {
      command: resolveNodeCommand(),
      args: [tsxCli, "--tsconfig", path.join(projectRoot, "tsconfig.json"), entryPoint],
      mode: "tsx",
    };
  }

  const compiled = compiledEntryPath(projectRoot, sourceRel);
  if (fs.existsSync(compiled)) {
    return { command: resolveNodeCommand(), args: [compiled], mode: "compiled" };
  }

  return null;
}

/** Shared tail for both call sites' "neither mode resolved" diagnostics. */
export function entryResolutionDiagnostic(projectRoot: string, sourceRel: string): string {
  return (
    `expected either ${path.join(projectRoot, sourceRel)} + ` +
    `${path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs")} (source mode), or ` +
    `${compiledEntryPath(projectRoot, sourceRel)} (compiled mode, built by \`npm run build:cli\` ` +
    `and shipped in the npm tarball). Check electron-builder.yml's files allowlist for a packaged ` +
    `build, or package.json's files allowlist for an npm install.`
  );
}
