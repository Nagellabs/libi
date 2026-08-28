/**
 * Thin wrapper around the user's `codex mcp` subcommand.
 *
 * Rather than editing `~/.codex/config.toml` ourselves (corruption-prone —
 * codex owns that file), libi shells out to `codex mcp add`/`remove`/`list`
 * so codex writes its OWN clean TOML. The child's `CODEX_HOME` is injected
 * from `resolveCodexHome()` (or an explicit override) so a worktree / dev /
 * test instance can never touch the user's real `~/.codex`.
 *
 * Verified flag syntax (Spike S1, codex-cli 0.142.5):
 *   stdio: codex mcp add <name> [--env K=V]… -- <command> <arg…>
 *   http:  codex mcp add <name> --url <url> --bearer-token-env-var <VAR>
 *   codex mcp remove <name>
 *   codex mcp list
 *
 * All three functions swallow errors and return a structured
 * `{ ok:false, stderr }` — they NEVER throw. 2s timeout on every call.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import fs from "node:fs";
import path from "node:path";
import { resolveCodexHome } from "./canonical";
import { userCommandSearchDirs } from "@/lib/shell-path-cache";
import { getLibiHome } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";
import { scrubSecrets } from "@/lib/security/secret-scrub";
import type { McpServerEntry } from "@/lib/mcp-config";
import { isWindows } from "@/lib/platform";

const execFileAsync = promisify(execFile);

const CODEX_BIN = "codex";
const TIMEOUT_MS = 2000;

/**
 * Where a `codex` executable came from — and therefore whether the PERSON
 * using this computer can run it.
 *
 * - `user`          — a codex that belongs to the user; their own terminal and
 *                     the Codex app can run it, so `codex mcp add` is worth
 *                     doing.
 * - `libi-internal` — a codex that exists only inside libi's own tree
 *                     (`<repo>/node_modules/.bin/codex`, the packaged
 *                     `…/libi-bundle/node_modules/…`, `<LIBI_HOME>/…`). Real,
 *                     runnable BY LIBI, and useless for this surface.
 * - `none`          — nothing found.
 */
export type CodexCliSource =
  | { kind: "user"; path: string }
  | { kind: "libi-internal"; path: string }
  | { kind: "none" };

/**
 * Everything about the probe that touches the world, injected so tests can run
 * it against a fixture layout with no real shell and no real filesystem.
 */
export interface UserCodexCliOpts {
  /** Directories to search, in priority order. Default: `codexSearchDirs()`. */
  searchDirs?: string[];
  /** Is `<dir>/codex` an executable file? Default: a real `fs` check. */
  isExecutable?: (candidate: string) => boolean;
  /** Resolve symlinks. Default: `fs.realpathSync`, falling back to the input. */
  realpath?: (candidate: string) => string;
  /** Roots that count as "inside libi". Default: `libiTreeRoots()`. */
  libiRoots?: string[];
}

/**
 * PATH entries from the login-shell PATH cache written by
 * `electron/path-bootstrap.ts` — the SAME cache `lib/runtime/node-runtime.ts`
 * reads (`cachedShellPathDirs`), read the same lenient way (a cache written
 * under a different `$SHELL` is still better evidence about the user than this
 * server process's own PATH).
 *
 * Deliberately no live login-shell probe: `path-bootstrap.ts` documents a
 * packaged boot that hung 10+ minutes inside a TCC-blocked `/bin/zsh` that no
 * timeout could kill. Reading its cache is free; re-spawning the shell is not.
 */
// Implementation lives in lib/shell-path-cache.ts — shared with
// lib/runtime/node-runtime.ts and lib/terminal/user-cli.ts so the "never
// re-probe the login shell" rule above is stated and enforced in one place.

/**
 * Directories searched for a `codex`, most-honest source first.
 *
 * The login-shell cache is what the USER's terminal would see. This process's
 * own PATH comes second as a fallback (there is no cache at all under the CLI
 * entry point, only the Electron shell writes one) — it is a superset of the
 * user's PATH under `npm run dev`, and the libi-internal classification below
 * is what stops its `node_modules/.bin` prefix from being mistaken for a user
 * install.
 */
export function codexSearchDirs(): string[] {
  return userCommandSearchDirs();
}

/** Executable file names a `codex` could have on this platform. */
function codexBinNames(): string[] {
  return isWindows()
    ? ["codex.exe", "codex.cmd", "codex.bat", "codex"]
    : [CODEX_BIN];
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

/**
 * Roots whose contents belong to LIBI, not to the user.
 *
 * `process.cwd()` is libi's package root in every server run mode. npm HOISTS
 * though: an installed copy (`…/libi-bundle/node_modules/@nagellabs/libi`, or
 * an `npx @nagellabs/libi` install) keeps its dependencies in an ANCESTOR
 * `node_modules`, so every `node_modules` ancestor's PARENT is a root too —
 * the same walk `codexCandidateTreeRoots` does in the agent registry. That
 * ancestor rule is what catches the packaged `…/libi-bundle/node_modules/.bin/codex`.
 * `<LIBI_HOME>` is a root because it has its own npm install root
 * (`~/.libi/node_modules`, `~/.libi/agents/node_modules`) full of libi's
 * packages.
 */
export function libiTreeRoots(startDir: string = process.cwd()): string[] {
  const roots = new Set<string>();
  roots.add(startDir);
  const segments = startDir.split(path.sep);
  for (let i = segments.length - 1; i > 0; i--) {
    if (segments[i] !== "node_modules") continue;
    const root = segments.slice(0, i).join(path.sep);
    roots.add(root === "" ? path.sep : root);
  }
  try {
    roots.add(getLibiHome());
  } catch {
    /* best-effort — a home we can't resolve just isn't a root */
  }
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
 * Classify ONE already-resolved codex path. Pure; exported for tests.
 *
 * Callers must pass the REALPATH: `<repo>/node_modules/.bin/codex` is a
 * symlink to `../@openai/codex/bin/codex.js`, and only one of those two spellings
 * needs to be inside a root for the answer to be "libi's".
 */
export function classifyCodexPath(resolved: string, roots: string[]): "user" | "libi-internal" {
  return roots.some((root) => isInside(resolved, root)) ? "libi-internal" : "user";
}

/**
 * Does the PERSON using this computer have their own `codex` CLI?
 *
 * This is the ONE place where a PATH probe for codex is the honest question:
 * everything else in this module shells out to the user's codex binary
 * (`codex mcp add`/`remove`/`list`) so that THEIR terminal and THEIR Codex app
 * can load libi's tools. It is deliberately NOT how ACP agent availability is
 * decided — `@agentclientprotocol/codex-acp` embeds its own engine and never
 * consults PATH (see `lib/agents/acp/agent-registry.ts#detectCodex`).
 *
 * Why it returns a source and not a boolean — measured, not theoretical:
 * `execSync("which codex")` inherits the NEXT.JS SERVER's PATH, and under
 * `npm run dev` npm prepends `<repo>/node_modules/.bin`, which since the
 * codex-acp migration contains `codex -> ../@openai/codex/bin/codex.js`
 * (transitive dep). On a machine whose owner has no codex at all, that probe
 * returned true, the Install button lit up, `codex mcp add` really ran and
 * really wrote `~/.codex/config.toml` — provisioning a codex that exists only
 * inside libi's `node_modules`. Nothing lied; the install was real and
 * worthless. A `libi-internal` hit must therefore be REFUSED, not accepted.
 *
 * Best-effort and never throws: an unreadable dir or a dangling symlink just
 * isn't a hit.
 *
 * Known limitation, inherited from every PATH probe in a desktop app: without
 * a login-shell PATH cache, a codex in an unusual prefix can be missed even
 * though the user's terminal finds it. That only gates the optional
 * `codex mcp add` convenience surface — never the in-app Codex agent.
 */
export function userCodexCli(opts: UserCodexCliOpts = {}): CodexCliSource {
  const dirs = opts.searchDirs ?? codexSearchDirs();
  const isExecutable = opts.isExecutable ?? defaultIsExecutable;
  const realpath = opts.realpath ?? defaultRealpath;
  const roots = opts.libiRoots ?? libiTreeRoots();
  const names = codexBinNames();

  const seen = new Set<string>();
  let internal: CodexCliSource | null = null;

  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (!isExecutable(candidate)) continue;

      const resolved = realpath(candidate);
      // Judge BOTH spellings: the shim itself and what it points at. Either
      // one landing inside libi's tree means this codex is libi's.
      const kind =
        classifyCodexPath(resolved, roots) === "libi-internal" ||
        classifyCodexPath(candidate, roots) === "libi-internal"
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
 * Codex's own server-name rule: `codex mcp add <name>` rejects anything outside
 * `[A-Za-z0-9_-]` ("invalid server name '…' (use letters, numbers, '-', '_')").
 */
export function isCodexValidServerName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

/**
 * Map a libi MCP server name to a codex-VALID one so it can be installed via
 * `codex mcp add`. libi has servers named with spaces (e.g. "YouTube
 * Downloader") that codex refuses — rather than DROP them (leaving the codex
 * agent without those tools), replace each run of invalid chars with a single
 * `-`. Already-valid names (`libi`, `fal-ai`) pass through unchanged; case is
 * preserved. `"YouTube Downloader"` → `"YouTube-Downloader"`.
 */
export function toCodexServerName(name: string): string {
  const sanitized = name
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "server";
}

/**
 * Injectable spawner (default: real `execFile`). Tests inject a fake that
 * records argv + env and NEVER spawns real codex.
 */
export type CodexSpawner = (
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultSpawner: CodexSpawner = (file, args, opts) =>
  // windowsHide: the Next server runs inside Electron's console-less main
  // process on Windows, so a console child gets a fresh Windows Terminal
  // window unless this is set — see lib/agents/process-manager.ts.
  execFileAsync(file, args, { ...opts, windowsHide: true });

export interface CodexCliOpts {
  /** Override the spawner (tests). Defaults to a real `execFile`. */
  spawner?: CodexSpawner;
  /** Override CODEX_HOME injected into the child env. Defaults to resolveCodexHome(). */
  codexHome?: string;
  /**
   * The codex executable to invoke — normally the exact path `userCodexCli()`
   * resolved. Defaults to the bare name `codex`, re-resolved against the child's
   * PATH.
   *
   * Pass it whenever you have already resolved one. The bare name is resolved
   * against THIS PROCESS's PATH, which is neither where the probe looked (the
   * login-shell cache can name a binary a Finder-launched server can't see →
   * ENOENT) nor necessarily the same binary (npm's `node_modules/.bin` prefix
   * shadows a real user install → the wrong codex). Naming the binary removes
   * both gaps; it does NOT change which config is edited — that is `codexHome`,
   * injected as CODEX_HOME below, independently of which executable runs.
   */
  bin?: string;
}

export type CodexCliResult =
  | { ok: true; stdout: string }
  | { ok: false; stderr: string };

/**
 * Extract the env-var name from a `Bearer ${VAR}` Authorization header, or null.
 * Lets `codex mcp add` deliver an HTTP MCP's bearer token as an env-var ref
 * (`--bearer-token-env-var`) instead of an inlined secret.
 */
function bearerEnvVar(headers: Record<string, string> | undefined): string | null {
  if (!headers) return null;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "authorization") continue;
    const match = value.match(/^Bearer\s+\$\{([A-Z0-9_]+)\}$/);
    if (match) return match[1];
  }
  return null;
}

/** Build the child env with CODEX_HOME injected. */
function childEnv(codexHome: string | undefined): NodeJS.ProcessEnv {
  return { ...process.env, CODEX_HOME: codexHome ?? resolveCodexHome() };
}

/** Pull a readable stderr out of whatever the spawner threw. */
function errStderr(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { stderr?: unknown; message?: unknown };
    if (typeof e.stderr === "string" && e.stderr.trim()) return e.stderr;
    if (typeof e.message === "string") return e.message;
  }
  return String(err);
}

/** Build the `mcp add …` argv for a server entry. */
function buildAddArgs(name: string, entry: McpServerEntry): string[] {
  if ("type" in entry && entry.type === "http") {
    const args = ["mcp", "add", name, "--url", entry.url];
    const envVar = bearerEnvVar(entry.headers);
    if (envVar) args.push("--bearer-token-env-var", envVar);
    return args;
  }

  const stdio = entry as { command: string; args?: string[]; env?: Record<string, string> };
  const args = ["mcp", "add", name];
  if (stdio.env) {
    // Known, accepted residual: unlike the HTTP branch above (which can pass
    // `--bearer-token-env-var <NAME>` and let codex read the value from its
    // own env), codex's stdio `mcp add` has no env-var-REFERENCE flag — see
    // the header contract. `codex mcp add` has to be TOLD the value so it can
    // record it for the MCP server it's registering, so it can only ever
    // arrive inline as `--env K=V`. That means the value is visible in `ps`
    // to any process running as this OS user for the ~instant this command
    // runs. Verified against the CLI's documented flag surface (see header);
    // do not "fix" this by routing it through the child's env instead — the
    // child here is `codex`, not the MCP server, so that would just make
    // registration silently do nothing. What IS fixed: this value never
    // reaches `~/.libi/logs/libi.log` — see `errStderr`/`run` below, which
    // scrub every configured secret out of a failure message before it's
    // logged or returned.
    for (const [k, v] of Object.entries(stdio.env)) {
      args.push("--env", `${k}=${v}`);
    }
  }
  args.push("--", stdio.command);
  if (stdio.args && stdio.args.length > 0) args.push(...stdio.args);
  return args;
}

/**
 * Secret VALUES potentially present in this entry, collected so a failure
 * message (which can embed the raw argv — see `errStderr`) is scrubbed of
 * them before it reaches the logger or a caller. Stdio env values are what
 * actually land in argv (see `buildAddArgs`); HTTP header values are
 * collected defensively even though only the env-var NAME is ever put on the
 * command line, mirroring `collectRowSecrets` in `mcp/registry/server-prober.ts`.
 */
function collectEntrySecrets(entry: McpServerEntry): string[] {
  const secrets: string[] = [];
  if ("type" in entry && entry.type === "http") {
    for (const v of Object.values(entry.headers ?? {})) {
      if (typeof v === "string" && v) secrets.push(v);
    }
    return secrets;
  }
  const stdio = entry as { env?: Record<string, string> };
  for (const v of Object.values(stdio.env ?? {})) {
    if (typeof v === "string" && v) secrets.push(v);
  }
  return secrets;
}

/**
 * `secrets` are the configured secret VALUES (e.g. inlined `--env K=V`
 * values) that might appear verbatim inside a spawn failure's message — Node
 * puts the full argv into `err.message` on an `execFile` rejection, and
 * `errStderr` above prefers that message when the child produced no stderr
 * of its own. Scrubbed UNCONDITIONALLY (an empty `secrets` list is a no-op)
 * before the message reaches the logger or the caller, so a key never lands
 * in `~/.libi/logs/libi.log` — exactly the file users paste into bug
 * reports. `lib/logger.ts`'s pino `redact` config is a backstop for this
 * class of leak generally, not a substitute for scrubbing at the source.
 */
async function run(
  op: "add" | "remove" | "list",
  args: string[],
  opts: CodexCliOpts,
  secrets: string[] = [],
): Promise<CodexCliResult> {
  const spawner = opts.spawner ?? defaultSpawner;
  try {
    const { stdout } = await spawner(opts.bin ?? CODEX_BIN, args, {
      env: childEnv(opts.codexHome),
      timeout: TIMEOUT_MS,
    });
    return { ok: true, stdout };
  } catch (err) {
    const stderr = scrubSecrets(errStderr(err), secrets);
    logger.warn({ tag: "codex-config", op, err: stderr }, `codex mcp ${op} failed`);
    return { ok: false, stderr };
  }
}

/** `codex mcp add <name> …` — stdio or HTTP depending on the entry shape. */
export async function mcpAdd(
  name: string,
  entry: McpServerEntry,
  opts: CodexCliOpts = {},
): Promise<CodexCliResult> {
  return run("add", buildAddArgs(name, entry), opts, collectEntrySecrets(entry));
}

/** `codex mcp remove <name>`. */
export async function mcpRemove(
  name: string,
  opts: CodexCliOpts = {},
): Promise<CodexCliResult> {
  return run("remove", ["mcp", "remove", name], opts);
}

/** `codex mcp list` — returns codex's stdout on success. */
export async function mcpList(opts: CodexCliOpts = {}): Promise<CodexCliResult> {
  return run("list", ["mcp", "list"], opts);
}

/**
 * Live read of which MCP server NAMES are currently configured in the codex
 * home, via `codex mcp list --json` (clean JSON — verified codex-cli 0.142.5).
 * Returns the name list on success, or `null` if codex isn't runnable / the
 * output can't be parsed. The status UI derives "installed" from whether
 * `libi` is present here — the ground truth, not libi's stored intent.
 */
export async function probeInstalledServers(
  opts: CodexCliOpts = {},
): Promise<string[] | null> {
  // A non-existent codex home means nothing is configured yet — and codex
  // itself ERRORS on a missing CODEX_HOME rather than reporting empty. Report
  // "no servers" directly instead of spawning codex just to log a warning.
  const home = opts.codexHome ?? resolveCodexHome();
  if (!fs.existsSync(home)) return [];

  const res = await run("list", ["mcp", "list", "--json"], opts);
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.stdout) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((s) => (s && typeof s === "object" ? (s as { name?: unknown }).name : undefined))
      .filter((n): n is string => typeof n === "string");
  } catch {
    return null;
  }
}
