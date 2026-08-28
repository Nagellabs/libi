// lib/runtime/node-abi-sidecars.ts
//
// The one place that describes better-sqlite3's per-Node-major sidecar
// bindings: which majors a runtime ships, where they live, and how to ask a
// tree whether it has any.
//
// ── Why sidecars exist at all ─────────────────────────────────────────────
// A packaged runtime is loaded by TWO interpreters:
//
//   * the Next server, inside the Electron main process → Electron's ABI
//   * the libi MCP stdio child, spawned as a REAL node by `buildLibiEntry()`
//     via `resolveNodeCommand()`                        → that node's ABI
//
// No plain Node release shares Electron's NODE_MODULE_VERSION (Electron 36 is
// 135; Node 22 is 127, Node 24 is 137), and the `runAsNode: false` fuse
// forbids re-using the app binary as a Node runtime — so the second one cannot
// be made to match. A runtime carrying ONLY the Electron binding boots a
// perfectly healthy UI in which every DB-backed `libi.*` tool dies at first
// agent use. Nothing surfaces the cause: the window, the server, the agent and
// every install status stay green.
//
// So a runtime parks a plain-Node binding per supported major at
// `better-sqlite3/build/Release-node-<major>/better_sqlite3.node`, and leaves
// the default `build/Release` to Electron's. `lib/db/native-binding.ts` picks
// the right one at connect time.
//
// ── This module is deliberately dependency-free ───────────────────────────
// `electron/runtime-loader.ts` value-imports it to gate a candidate runtime
// BEFORE executing any of its code, and that file is esbuild-bundled into the
// thin shell. Anything imported here would be dragged into the shell bundle,
// which is the exact coupling the shell/runtime split removes. Node builtins
// only — no `@/lib/...`, ever.

import fs from "node:fs";
import path from "node:path";

/**
 * Node majors a runtime fetches a sidecar binding for.
 *
 * The range spans every major `ensureNodeRuntime()` has ever been able to put
 * at `<LIBI_HOME>/bin/node`, up through the major of `PINNED_NODE_VERSION`
 * (lib/runtime/node-runtime.ts). Its floor deliberately trails MIN_NODE_MAJOR
 * (now 22), and NOT because already-provisioned 20/21 bindings survive — they
 * don't: `acceptable()` rejects a managed node below the minimum, so one gets
 * de-provisioned and replaced with the pinned build. The 20/21 sidecars earn
 * their bytes on the DEGRADED path instead: `resolveNativeBinding` keys purely
 * on the running interpreter's major, so if `ensureNodeRuntime` fails outright
 * and `resolveNodeCommand()` falls back to a bare `node` that happens to be a
 * system 20 or 21, the binding is still there. Shrinking the list would also
 * touch scripts/build-runtime-bundle.js's literal copy and its drift test.
 *
 * **This is not the full set of interpreters that can reach the binding.**
 * `ensureNodeRuntime` links any system node at or above the minimum with no
 * upper bound, so a machine whose `node` is newer than this list (Homebrew's
 * current is 25.x) gets an interpreter with no sidecar. That is handled by
 * `resolveNativeBinding` refusing loudly rather than by pretending the list is
 * exhaustive — see the comment there. An earlier version of this comment
 * claimed the two sets were equal and refuted itself in the next clause.
 *
 * `scripts/build-runtime-bundle.js` keeps a literal copy (it is plain CJS and
 * cannot import TypeScript); `__tests__/unit/runtime/node-abi-sidecars.test.ts`
 * asserts the two never drift.
 */
export const NODE_ABI_SIDECAR_MAJORS = [20, 21, 22, 23, 24] as const;

/** `<prefix>/node_modules/better-sqlite3` for an npm install prefix. */
export function betterSqliteModuleDir(prefix: string): string {
  return path.join(prefix, "node_modules", "better-sqlite3");
}

/** `<prefix>/node_modules/better-sqlite3/build`. */
export function betterSqliteBuildDir(prefix: string): string {
  return path.join(betterSqliteModuleDir(prefix), "build");
}

/** Directory name for one major's sidecar, relative to the build dir. */
export function sidecarDirName(major: number | string): string {
  return `Release-node-${major}`;
}

/**
 * Node majors this build dir carries sidecar bindings for, ascending.
 *
 * Empty means one of two very different things — a plain-`npx` install (npm
 * compiled `build/Release` for the running node, and no sidecars are wanted) or
 * a packaged runtime that shipped without them (broken). Callers distinguish;
 * this function only reports.
 */
export function sidecarMajorsIn(buildDir: string): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(buildDir);
  } catch {
    return [];
  }
  return names
    .map((name) => /^Release-node-(\d+)$/.exec(name)?.[1])
    .filter((m): m is string => m != null)
    .filter((m) =>
      fileHasBytes(path.join(buildDir, sidecarDirName(m), "better_sqlite3.node")),
    )
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * Sidecar majors present in an install PREFIX (as opposed to a build dir).
 * The shape `electron/runtime-loader.ts` asks about.
 */
export function sidecarMajorsInPrefix(prefix: string): number[] {
  return sidecarMajorsIn(betterSqliteBuildDir(prefix));
}

/** A zero-length file is a failed copy, not a binding. */
function fileHasBytes(file: string): boolean {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}
