// lib/db/native-binding.ts
//
// Pick the better-sqlite3 native binding that matches the interpreter this
// process is actually running under.
//
// ── The two-interpreter problem ───────────────────────────────────────────
// In the PACKAGED Electron app, product code runs under two different
// interpreters against ONE installed runtime snapshot:
//
//   * the Next server, inside the Electron main process   → Electron's ABI
//   * the libi MCP stdio child, spawned as a real node by
//     `buildLibiEntry()` → `resolveNodeCommand()`         → that node's ABI
//
// better-sqlite3 is the one dependency stamped with a NODE_MODULE_VERSION, and
// no plain Node release shares Electron's (Electron 36 = 135, Node 22 = 127,
// Node 24 = 137). The child cannot be made to run under Electron either: the
// `runAsNode: false` fuse deliberately forbids re-using the app binary as a
// Node runtime.
//
// So a bundle carrying only the Electron binding produces an app that looks
// completely healthy — window, server, agent, tool list — in which EVERY
// DB-backed `libi.*` tool fails with "The module … was compiled against a
// different Node.js version". That is what this module exists to prevent.
//
// `scripts/build-runtime-bundle.js` parks a per-major plain-Node binding at
// `better-sqlite3/build/Release-node-<major>/better_sqlite3.node`; this module
// finds it and hands the path to better-sqlite3's `nativeBinding` option
// (drizzle forwards every non-`source` connection key straight to the
// `Database` constructor).
//
// ── Why it is a no-op everywhere else ─────────────────────────────────────
// Under Electron the default `build/Release` binding is already the right one,
// so we return undefined before looking at the disk at all. Under a plain
// `npx @nagellabs/libi` install there are no sidecars — npm built/fetched
// build/Release for the running node — so the search finds nothing and returns
// undefined. In both cases behaviour is byte-for-byte what it was.

import fs from "fs";
import path from "path";

import { sidecarDirName, sidecarMajorsIn } from "@/lib/runtime/node-abi-sidecars";

/** Minimal env/versions shapes — the project augments NodeJS.ProcessEnv to a
 *  closed set of known keys, which a test fixture object cannot satisfy. */
type EnvLike = Record<string, string | undefined>;
type VersionsLike = { node?: string; electron?: string };

/** Directory holding sidecar bindings, when the parent process names one. */
const BINDING_DIR_ENV = "LIBI_SQLITE_BINDING_DIR";

/**
 * Candidate `better-sqlite3/build` directories, in priority order.
 *
 * Deliberately NOT `require.resolve("better-sqlite3")`: this module is loaded
 * both from the compiled CJS MCP child and from Next's bundled server, and a
 * bare `require` exists in only one of them. The layouts below are the two the
 * runtime actually ships as — a runtime root inside an npm prefix
 * (`<prefix>/node_modules/@nagellabs/libi`, dependency one level up at
 * `<prefix>/node_modules/better-sqlite3`) and a plain checkout — plus an
 * explicit env override for anything exotic.
 */
export function candidateBuildDirs(cwd: string, env: EnvLike): string[] {
  const dirs: string[] = [];
  const explicit = env[BINDING_DIR_ENV];
  if (explicit) dirs.push(explicit);
  dirs.push(
    // A checkout / a hoisted install: <cwd>/node_modules/better-sqlite3
    path.join(cwd, "node_modules", "better-sqlite3", "build"),
    // Installed as @nagellabs/libi: <prefix>/node_modules/@nagellabs/libi is cwd,
    // so the dependency sits two levels up.
    path.join(cwd, "..", "..", "better-sqlite3", "build"),
    // Unscoped install: <prefix>/node_modules/<pkg> is cwd.
    path.join(cwd, "..", "better-sqlite3", "build"),
  );
  return dirs;
}

/**
 * The `better-sqlite3/build` directory this process can see, for handing to
 * CHILD processes via `LIBI_SQLITE_BINDING_DIR` (`mcp/registry/spawn-env.ts`).
 *
 * The child's own `process.cwd()` is not a reliable base — an MCP child is
 * spawned by the ACP adapter, which sets its own working directory (the agent
 * workspace), so the layouts above would all miss. The SERVER always knows
 * where its runtime lives, so it resolves the directory once and names it.
 */
export function sqliteBuildDirForChildren(
  cwd: string = process.cwd(),
  env: EnvLike = process.env,
): string | undefined {
  for (const dir of candidateBuildDirs(cwd, env)) {
    try {
      if (fs.existsSync(dir)) return path.resolve(dir);
    } catch {
      /* unreadable candidate — try the next one */
    }
  }
  return undefined;
}

/**
 * Absolute path to a binding matching this interpreter, or undefined to use
 * better-sqlite3's own default resolution.
 */
export function resolveNativeBinding(
  cwd: string = process.cwd(),
  env: EnvLike = process.env,
  versions: VersionsLike = process.versions,
): string | undefined {
  // Inside Electron the default binding IS this interpreter's binding.
  if (versions.electron) return undefined;

  const major = (versions.node ?? "").split(".")[0];
  if (!major) return undefined;

  const sidecarMajorsSeen = new Set<string>();
  for (const dir of candidateBuildDirs(cwd, env)) {
    const candidate = path.join(dir, sidecarDirName(major), "better_sqlite3.node");
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* unreadable candidate — try the next one */
    }
    for (const m of sidecarMajorsIn(dir)) sidecarMajorsSeen.add(String(m));
  }

  // A miss means one of two VERY different things, and returning `undefined`
  // for both is what made two separate release blockers invisible.
  //
  //  - No `Release-node-*` sidecars anywhere ⇒ the plain-`npx` layout, where
  //    `build/Release` was compiled by npm for whichever node ran the install.
  //    That IS this interpreter's binding, so `undefined` (let better-sqlite3
  //    resolve normally) is correct.
  //  - Sidecars exist but none for THIS major ⇒ the packaged-runtime layout,
  //    where `build/Release` is deliberately the ELECTRON binding. Falling
  //    through to it under a plain node loads a binding compiled for a
  //    different ABI: `require` succeeds and `new Database()` either throws
  //    ERR_DLOPEN or SIGKILLs the process. Every DB-backed `libi.*` tool then
  //    fails while the UI and every install status stay green — measured twice
  //    on this branch (a fetched runtime carrying no sidecars at all, and a
  //    linked system node whose major is outside the shipped set).
  //
  // So refuse loudly here rather than let the wrong binary load. The message
  // names both majors because the fix differs: widen the shipped set, or point
  // LIBI_SQLITE_BINDING_DIR at a tree that has one.
  if (sidecarMajorsSeen.size > 0) {
    const shipped = [...sidecarMajorsSeen].sort((a, b) => Number(a) - Number(b));
    throw new Error(
      `better-sqlite3 has no binding for Node ${major}. This runtime ships ` +
        `bindings for Node ${shipped.join(", ")} only, and its default ` +
        `build/Release is Electron's — loading it under Node ${major} would ` +
        `crash on the first query. Run libi with one of the supported Node ` +
        `majors, or set LIBI_SQLITE_BINDING_DIR to a build dir containing ` +
        `Release-node-${major}/better_sqlite3.node.`,
    );
  }
  return undefined;
}

