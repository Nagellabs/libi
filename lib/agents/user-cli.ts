/**
 * Shared "does the PERSON using this computer have their own copy of this
 * CLI" probe. Originally written for `codex` (`lib/codex-config/codex-cli.ts`)
 * and lifted here so `claude` can reuse the exact same rules: walk the
 * login-shell search dirs, judge both the shim path and its realpath target
 * against libi's own tree roots, and prefer a real user install anywhere on
 * the search path over an in-tree shim that happened to sort earlier.
 *
 * The CLI resolver (`lib/agents/cli/resolve.ts`) is what calls it; this
 * module holds the mechanism and the measured PATH-probe failure modes.
 */

import fs from "node:fs";
import path from "node:path";
import { userCommandSearchDirs } from "@/lib/shell-path-cache";
import { getLibiHome } from "@/lib/libi-home";
import { isWindows } from "@/lib/platform";
import { packageRoot } from "@/lib/runtime/package-root";

/**
 * Where a CLI executable came from — and therefore whether the PERSON using
 * this computer can run it.
 *
 * - `user`          — belongs to the user; their own terminal (and whatever
 *                     app shells out to it) can run it.
 * - `libi-internal` — exists only inside libi's own tree. Real, runnable BY
 *                     LIBI, and useless for "does the user have this"
 *                     purposes.
 * - `none`          — nothing found.
 */
export type UserCliSource =
  | { kind: "user"; path: string }
  | { kind: "libi-internal"; path: string }
  | { kind: "none" };

/**
 * Everything about the probe that touches the world, injected so tests can
 * run it against a fixture layout with no real shell and no real filesystem.
 */
export interface FindUserCliOpts {
  /** Directories to search, in priority order. Default: `userCommandSearchDirs()`. */
  searchDirs?: string[];
  /** Is `<dir>/<name>` an executable file? Default: a real `fs` check. */
  isExecutable?: (candidate: string) => boolean;
  /** Resolve symlinks. Default: `fs.realpathSync`, falling back to the input. */
  realpath?: (candidate: string) => string;
  /** Roots that count as "inside libi". Default: `libiTreeRoots()`. */
  libiRoots?: string[];
  /**
   * Where libi's own package root is, for the default `libiTreeRoots()` walk.
   * Default: `packageRoot(__dirname)`. Injectable so a test can point "libi's
   * install" at a fixture layout without also having to hand-build the whole
   * root set the way `libiRoots` does.
   */
  packageRootDir?: string;
  /** Platform to derive Windows executable spellings for. Default: `process.platform`. */
  platform?: NodeJS.Platform;
}

function defaultIsExecutable(candidate: string): boolean {
  try {
    const st = fs.statSync(candidate);
    if (!st.isFile()) return false;
    if (isWindows()) return true;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultRealpath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

/** The `node_modules`-ancestor walk `libiTreeRoots` does for ONE start dir. */
function treeRootsFrom(startDir: string): string[] {
  const roots = new Set<string>();
  roots.add(startDir);
  const segments = startDir.split(path.sep);
  for (let i = segments.length - 1; i > 0; i--) {
    if (segments[i] !== "node_modules") continue;
    const root = segments.slice(0, i).join(path.sep);
    roots.add(root === "" ? path.sep : root);
  }
  return [...roots];
}

/** libi's own npm name — the string a consumer's `package.json` declares. */
const LIBI_PACKAGE = "@nagellabs/libi";

/**
 * Does `<dir>/package.json` declare libi as one of its dependencies?
 *
 * This is what separates "npm hoisted libi's deps up here" from "this just
 * happens to be a `node_modules` ancestor". Best-effort: a missing or
 * unparseable manifest is simply not a declaration.
 */
function declaresLibi(dir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return Boolean(
      pkg.dependencies?.[LIBI_PACKAGE] ??
        pkg.devDependencies?.[LIBI_PACKAGE] ??
        pkg.optionalDependencies?.[LIBI_PACKAGE],
    );
  } catch {
    return false;
  }
}

/**
 * Roots derived from libi's OWN package root.
 *
 * The root itself always counts — everything under it, including its nested
 * `node_modules`, is libi's. The `node_modules` ancestors' parents count only
 * when they DECLARE libi, because that is what makes them the tree npm hoisted
 * libi's dependencies into. Two layouts share the same shape and need opposite
 * answers:
 *
 * - consumer project — `<app>/node_modules/@nagellabs/libi` with the deps
 *   hoisted to `<app>/node_modules/@openai/codex`. `<app>/package.json`
 *   declares `@nagellabs/libi`, so `<app>` is libi's turf and
 *   `<app>/node_modules/.bin/codex` is correctly `libi-internal`.
 * - global install — `<prefix>/lib/node_modules/@nagellabs/libi`, deps NESTED
 *   underneath it because npm never hoists across global packages.
 *   `<prefix>/lib` is npm's global root, shared with every OTHER global package
 *   the user installed, and there is no `package.json` there at all. Claiming
 *   it used to make the user's own `<prefix>/bin/claude` (realpath
 *   `<prefix>/lib/node_modules/@anthropic-ai/claude-code/…`) read as
 *   `libi-internal`, so `libi connect` refused a perfectly good claude.
 */
function libiPackageRoots(root: string): string[] {
  return [root, ...treeRootsFrom(root).filter((dir) => dir !== root && declaresLibi(dir))];
}

/**
 * The MAIN worktree's root, when `dir` sits inside a LINKED git worktree.
 *
 * `.git` is a directory in a normal checkout and a FILE in a linked worktree,
 * holding `gitdir: <main>/.git/worktrees/<name>`. Reading it is how the main
 * checkout is found without shelling out to git (this runs on a readiness
 * probe, not in a build step).
 *
 * Why it matters: feature work happens in `.claude/worktrees/<name>/`,
 * and from there `<canonical>/node_modules/.bin/codex` is not inside ANY root
 * derived from the worktree — libi's own package root is the worktree, and
 * `<LIBI_HOME>` is a different directory again. So the codex probe accepted
 * the canonical checkout's in-tree shim as "the user's own codex", which is
 * precisely the misclassification `libiInstallRoots` exists to prevent, one
 * directory over. Both checkouts are libi's tree; only one of them was being
 * called that.
 *
 * Returns null for a normal checkout, for anything not in a repo, and for any
 * `.git` file it cannot parse — this only ever ADDS a root, and a root it
 * cannot justify is one it does not add.
 */
function mainWorktreeRoot(dir: string): string | null {
  let current = dir;
  for (;;) {
    const dotGit = path.join(current, ".git");
    try {
      const st = fs.statSync(dotGit);
      // A real `.git/` directory: this IS the main worktree, nothing to add.
      if (st.isDirectory()) return null;
      if (st.isFile()) {
        const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, "utf-8"))?.[1];
        if (!gitdir) return null;
        // `<main>/.git/worktrees/<name>` → `<main>`. Both separators are
        // accepted: git writes POSIX slashes into this file on Windows too.
        const m = /^(.*?)[\\/]\.git[\\/]worktrees[\\/]/.exec(gitdir);
        return m?.[1] ? m[1] : null;
      }
    } catch {
      /* no `.git` here — keep walking up */
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Memoised per start dir: `libiTreeRoots` runs on every readiness probe and
 *  the answer cannot change for the life of a process. */
const mainWorktreeRootCache = new Map<string, string | null>();

function addMainWorktreeRoots(roots: Set<string>): void {
  for (const root of [...roots]) {
    let main = mainWorktreeRootCache.get(root);
    if (main === undefined) {
      main = mainWorktreeRoot(root);
      mainWorktreeRootCache.set(root, main);
    }
    if (main) roots.add(main);
  }
}

/** Tests only — the cache is per process by design. */
export function _resetMainWorktreeRootCache(): void {
  mainWorktreeRootCache.clear();
}

/** Add `<LIBI_HOME>` to a root set, best-effort. */
function addLibiHome(roots: Set<string>): void {
  try {
    roots.add(getLibiHome());
  } catch {
    /* best-effort — a home we can't resolve just isn't a root */
  }
}

/**
 * The roots libi actually OWNS on this machine, with NO `process.cwd()`
 * component: libi's own package root (gated by `libiPackageRoots`) plus
 * `<LIBI_HOME>`.
 *
 * `libiTreeRoots()`'s no-arg default also walks `process.cwd()`. That is right
 * for the server — cwd IS the package root there — and wrong for `libi
 * connect`: under an installed `npx @nagellabs/libi connect`, `bin/libi.js`
 * chdirs only in a dev checkout, so `process.cwd()` is the USER's folder, the
 * very folder being connected. Every absolute path under it then read as
 * `libi-internal`, which is harmless for a "does the user have their own CLI"
 * probe but catastrophic for anything that DELETES on the strength of a root:
 * `cleanupLegacyConnectFiles` ate a user's own `.mcp.json` entry pointing at
 * their own file. Callers that delete must use THIS function.
 */
export function libiInstallRoots(packageRootDir?: string): string[] {
  const roots = new Set(libiPackageRoots(packageRootDir ?? packageRoot(__dirname)));
  addLibiHome(roots);
  return [...roots];
}

/**
 * Roots whose contents belong to LIBI, not to the user.
 *
 * `<LIBI_HOME>` is a root because it has its own npm install root
 * (`~/.libi/node_modules`, `~/.libi/agents/node_modules`) full of libi's
 * packages.
 *
 * Pass `startDir` to root the walk somewhere specific (tests, a hypothetical
 * layout). It gets the SAME treatment as the default: the start dir itself is
 * always a root, and its `node_modules` ancestors count only when they declare
 * libi. Gating only the default path left the explicit one able to claim npm's
 * shared global root — the very layout `libiPackageRoots` exists to exclude.
 *
 * Left at its default the roots come from BOTH `libiInstallRoots()` (libi's
 * own package root, anchored on THIS MODULE's location and correct regardless
 * of the caller's cwd, plus `<LIBI_HOME>`) AND the plain walk from
 * `process.cwd()` (unioned, deduped), so the server-side default — where cwd
 * already IS the package root — is unchanged. The package-root half is what
 * `libi connect` needs: `process.cwd()` alone is the user's folder there, not
 * libi's install, and that used to misclassify a hoisted
 * `<consumer>/node_modules/.bin/codex` as the user's own codex — see
 * the `lib/cli/connect-command.ts` prototype.
 *
 * The cwd half only ever ADDS roots, so it can only ever widen "this is
 * libi's". Anything that deletes on that answer wants `libiInstallRoots()`
 * instead — which is also why the linked-worktree hop (`addMainWorktreeRoots`)
 * lives here and not there.
 */
export function libiTreeRoots(startDir?: string, packageRootDir?: string): string[] {
  const roots = new Set<string>();
  if (startDir !== undefined) {
    for (const root of libiPackageRoots(startDir)) roots.add(root);
  } else {
    for (const root of libiInstallRoots(packageRootDir)) roots.add(root);
    for (const root of treeRootsFrom(process.cwd())) roots.add(root);
  }
  // Running inside a linked git worktree, the MAIN checkout is libi's tree too
  // — and its `node_modules/.bin/codex` used to read as the user's own.
  // Added here and NOT in `libiInstallRoots`, on purpose: this function only
  // ever widens "this is libi's", while anything that DELETES on that answer
  // uses `libiInstallRoots`, and widening a delete-root to a sibling checkout
  // is how `cleanupLegacyConnectFiles` ate a user's own `.mcp.json` entry.
  addMainWorktreeRoots(roots);
  addLibiHome(roots);
  return [...roots];
}

/** Is `candidate` at or beneath `root`? */
function isInside(candidate: string, root: string): boolean {
  if (!root) return false;
  const rel = path.relative(root, candidate);
  if (rel === "") return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Classify ONE already-resolved path. Pure; exported for tests.
 *
 * Callers must pass the REALPATH: `<repo>/node_modules/.bin/codex` is a
 * symlink to `../@openai/codex/bin/codex.js`, and only one of those two
 * spellings needs to be inside a root for the answer to be "libi's".
 */
export function classifyCliPath(resolved: string, roots: string[]): "user" | "libi-internal" {
  return roots.some((root) => isInside(resolved, root)) ? "libi-internal" : "user";
}

/** Executable-name spellings to try for `name` on `platform`. */
function binNames(name: string, platform: NodeJS.Platform): string[] {
  return platform === "win32" ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
}

/**
 * Does the PERSON using this computer have their own copy of a CLI named (on
 * a POSIX platform) one of `binNames`?
 *
 * Best-effort and never throws: an unreadable dir or a dangling symlink just
 * isn't a hit. A PATH probe inherits the server's PATH, whose
 * `node_modules/.bin` prefix holds libi's own codex/claude shims — which is why
 * a hit is classified by where it really lives, not just accepted.
 */
export function findUserCli(binNames_: string[], opts: FindUserCliOpts = {}): UserCliSource {
  const platform = opts.platform ?? process.platform;
  const dirs = opts.searchDirs ?? userCommandSearchDirs();
  const isExecutable = opts.isExecutable ?? defaultIsExecutable;
  const realpath = opts.realpath ?? defaultRealpath;
  const roots = opts.libiRoots ?? libiTreeRoots(undefined, opts.packageRootDir);
  const names = binNames_.flatMap((name) => binNames(name, platform));
  const join = platform === "win32" ? path.win32.join : path.posix.join;

  const seen = new Set<string>();
  let internal: UserCliSource | null = null;

  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (!isExecutable(candidate)) continue;

      const resolved = realpath(candidate);
      // Judge BOTH spellings: the shim itself and what it points at. Either
      // one landing inside libi's tree means this CLI is libi's.
      const kind =
        classifyCliPath(resolved, roots) === "libi-internal" ||
        classifyCliPath(candidate, roots) === "libi-internal"
          ? "libi-internal"
          : "user";

      // A real user install anywhere on the search path wins over an in-tree
      // shim that happened to be earlier (npm puts `node_modules/.bin` first).
      if (kind === "user") return { kind, path: candidate };
      internal ??= { kind, path: candidate };
    }
  }

  return internal ?? { kind: "none" };
}

/**
 * Where a desktop-app install of Codex keeps its CLI, searched AFTER every
 * PATH entry so a codex the user put on PATH themselves always wins.
 *
 * On macOS the ChatGPT desktop app ships `codex` inside its bundle
 * (`/Applications/ChatGPT.app/Contents/Resources/codex`, codex-cli 0.153.4
 * measured 2026-09-07) and puts NOTHING on PATH — `which codex` in a fresh
 * login shell finds nothing, yet the binary runs, reads the user's real
 * `~/.codex`, and `codex mcp add` written through it is exactly what the
 * Codex app loads. Without this fallback `libi connect` told such a user
 * "codex is not on your PATH" and printed a command their shell could not
 * run. The standalone Codex app and per-user `~/Applications` installs use
 * the same bundle layout. Other platforms: nothing known yet, so nothing
 * guessed.
 *
 * Lives here, beside the probe mechanism, so the CLI resolver
 * (`lib/agents/cli/resolve.ts`) can use it without importing the Codex
 * config module.
 */
export function codexAppBundleDirs(platform: NodeJS.Platform, home: string): string[] {
  if (platform !== "darwin") return [];
  const dirs: string[] = [];
  for (const base of ["/Applications", path.join(home, "Applications")]) {
    for (const app of ["ChatGPT.app", "Codex.app"]) {
      dirs.push(path.join(base, app, "Contents", "Resources"));
    }
  }
  return dirs;
}
