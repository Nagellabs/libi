import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverLogger as logger } from "@/lib/logger";
import { testRoutesEnabled } from "@/lib/security/test-routes";
import { codexAppBundleDirs, findUserCli, libiTreeRoots, type UserCliSource } from "@/lib/agents/user-cli";
import type { SetupAgentId } from "@/lib/agents/setup/commands";
import { AGENT_CLI_MIN_VERSION } from "./min-versions";
import {
  LOGIN_SHELL_PROBE_EXIT_WAIT_MS,
  LOGIN_SHELL_PROBE_KILL_GRACE_MS,
  LOGIN_SHELL_PROBE_TIMEOUT_MS,
  loginShellPathDirs,
} from "./login-shell-path";
import { parseFirstSemver, satisfiesMinimum } from "./version";
import { resolveCmdShimNativeTarget, resolveCmdShimTarget, spawnViaNodeIfScript } from "./spawn-shape";
import { endGroup, killGroup, releaseStdout, watchExit } from "./process-group";

/**
 * THE resolver of the user's own CLI. Nothing else in the app may answer "is
 * claude/codex installed": the status route, the process manager (which sets
 * CLAUDE_CODE_EXECUTABLE / CODEX_PATH from `execPath`), provider detection and
 * libi-registration detection all read this.
 *
 * Order: login-shell PATH (fresh, bounded — `login-shell-path.ts`) → this
 * process's PATH → known install folders. A hit inside libi's own tree is
 * rejected (`findUserCli`'s `libi-internal`). The hit is realpath'd (fnm/nvm
 * shims move per shell), then `--version` is run under a HARD 3 s bound
 * (`runCliVersion`); a binary that fails, hangs or prints no semver is
 * `foundButBroken`. Memoized 30 s per agent: fresh while the found path still
 * leads to the same realPath and that file's mtime is unchanged.
 */
export const CLI_BIN_NAME: Record<SetupAgentId, string> = { "claude-code": "claude", codex: "codex" };
export const AGENT_CLI_MEMO_MS = 30_000;
/** No caller waits longer than this for `--version`, whatever the binary does. */
export const AGENT_CLI_VERSION_TIMEOUT_MS = 3_000;
/**
 * The longest `holdEventLoop` keeps a process alive: the login-shell probe's worst
 * case (timeout, SIGTERM, grace, SIGKILL, exit wait) plus the `--version` bound, and
 * a second of slack. Every path settles inside it; the hold exists only so that
 * nothing ends the process first, and it is dropped the moment the resolution settles.
 */
export const AGENT_CLI_RESOLVE_HOLD_MS =
  LOGIN_SHELL_PROBE_TIMEOUT_MS + LOGIN_SHELL_PROBE_KILL_GRACE_MS + LOGIN_SHELL_PROBE_EXIT_WAIT_MS + AGENT_CLI_VERSION_TIMEOUT_MS + 1_000;
/** `--version` prints one line; anything past this is not read. */
const VERSION_STDOUT_CAP = 64 * 1024;

type VersionResult = { ok: boolean; stdout: string };
const versionFailed = (): VersionResult => ({ ok: false, stdout: "" });

export type ResolvedAgentCli =
  | { path: string; realPath: string; execPath: string; version: string; meetsMinimum: boolean }
  | { foundButBroken: true; path: string }
  | null;

export function isUsableCli(
  r: ResolvedAgentCli,
): r is { path: string; realPath: string; execPath: string; version: string; meetsMinimum: true } {
  return r !== null && "meetsMinimum" in r && r.meetsMinimum;
}

export interface ResolveAgentCliDeps {
  /**
   * PRODUCTION option (session start): when a USABLE memo exists for the agent —
   * even an expired one — return it immediately and refresh an expired one in the
   * background, so a session start never waits on the login-shell probe or
   * `--version` once the CLI has been resolved as usable. A memo that would refuse
   * the start (below the minimum, broken) or whose binary has vanished is resolved
   * afresh instead: only a caller that would otherwise be refused pays the wait.
   */
  staleOk?: boolean;
  /**
   * ONE-SHOT PROCESS option (`libi connect`): keep the event loop alive until this
   * resolution settles. The login-shell probe unrefs its shell and the shell's stdout
   * so a long-lived server is never held open by a probe. In a process nothing else
   * holds open that means Node goes idle and exits while the answer is on its way,
   * with this promise still pending — the command then silently does nothing. The
   * hold is ONE ref'd timer, bounded by AGENT_CLI_RESOLVE_HOLD_MS and cleared as soon
   * as the resolution settles; the probe's own timeout and kill are unchanged.
   */
  holdEventLoop?: boolean;
  /** Replaces the whole search-dir computation (tests). */
  searchDirs?: () => Promise<string[]>;
  loginShellPathDirs?: () => Promise<string[]>;
  processPathDirs?: () => string[];
  knownDirs?: string[];
  isExecutable?: (p: string) => boolean;
  realpath?: (p: string) => string;
  readFile?: (p: string) => string;
  libiRoots?: string[];
  platform?: NodeJS.Platform;
  /** Runs `--version` in place of `runCliVersion`; whatever it does, the resolver bounds it (`AGENT_CLI_VERSION_TIMEOUT_MS`). */
  spawnVersion?: (spawn: { command: string; args: string[] }) => Promise<VersionResult>;
  now?: () => number;
  mtimeOf?: (p: string) => number | null;
  minimum?: Record<SetupAgentId, string>;
}

/** Known install folders, searched AFTER PATH. */
export function knownInstallDirs(agentId: SetupAgentId, platform: NodeJS.Platform, home: string): string[] {
  if (platform === "win32") {
    const dirs = [path.win32.join(home, ".local", "bin")];
    if (agentId === "codex") {
      // The official Codex installer (install.ps1) puts codex.exe in
      // %LOCALAPPDATA%\Programs\OpenAI\Codex\bin — a THIRD location, not `%USERPROFILE%\.local\bin`.
      // Kept as a %VAR% template and expanded here: a per-user absolute path would be wrong on
      // every other machine. String.raw: in a normal literal "\P", "\O", "\C" and "\b" would be
      // eaten as escapes ("\b" silently becomes a backspace).
      const expanded = expandWindowsTemplate(String.raw`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`, home);
      if (expanded && !dirs.includes(expanded)) dirs.push(expanded);
    }
    return dirs;
  }
  const dirs = [path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  // The ChatGPT / Codex desktop apps ship a codex inside the bundle and put nothing on PATH (none off macOS).
  if (agentId === "codex") dirs.push(...codexAppBundleDirs(platform, home));
  return dirs;
}

/** `%USERPROFILE%` / `%LOCALAPPDATA%` → real folders (LOCALAPPDATA falls back to `<home>\AppData\Local`). */
function expandWindowsTemplate(template: string, home: string): string {
  const localAppData = process.env.LOCALAPPDATA ?? path.win32.join(home, "AppData", "Local");
  return template.replace(/%USERPROFILE%/gi, home).replace(/%LOCALAPPDATA%/gi, localAppData);
}

/**
 * `LIBI_TEST_AGENT_CLI_DIRS` (path.delimiter-separated) — an e2e hook that
 * replaces the whole search order, honoured only when test routes are enabled —
 * both read from `env`.
 */
export function testAgentCliDirs(env: NodeJS.ProcessEnv = process.env): string[] | null {
  if (!testRoutesEnabled(env)) return null;
  const raw = env.LIBI_TEST_AGENT_CLI_DIRS;
  if (!raw) return null;
  return raw.split(path.delimiter).filter(Boolean);
}

export interface CliVersionDeps {
  spawn?: typeof nodeSpawn;
  /** The host platform: off Windows the check leads its own process group. */
  platform?: NodeJS.Platform;
}

/**
 * The default `--version` runner. The caller gets `{ ok: false }` no later than
 * AGENT_CLI_VERSION_TIMEOUT_MS after the spawn, whatever the binary does — it is
 * never kept waiting for a hung process to die. Off Windows the binary runs in its
 * own process group (`detached: true`), so on timeout SIGTERM reaches it AND
 * anything it started (a wrapper's child, a background job holding stdout open);
 * SIGKILL follows the grace, then at most the exit wait, all after the caller has
 * been released. A process still there is counted (`notExitedAfterKill`). Windows
 * has no process groups: the child itself is signalled.
 *
 * The answer is `close` (ok = exit 0) — or, sooner, an `exit` with code 0 once the
 * captured stdout holds a complete line with a semver: a working CLI that leaves a
 * child holding stdout open must not read as broken. Its group is then ended the way
 * the login-shell probe ends its own (SIGTERM → grace → SIGKILL → exit wait, only if
 * anything is left), after the caller has its answer.
 */
export function runCliVersion(cmd: { command: string; args: string[] }, deps: CliVersionDeps = {}): Promise<VersionResult> {
  const spawn = deps.spawn ?? nodeSpawn;
  const platform = deps.platform ?? process.platform;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd.command, cmd.args, {
        stdio: ["ignore", "pipe", "ignore"],
        detached: platform !== "win32",
        windowsHide: true,
      });
    } catch {
      resolve(versionFailed());
      return;
    }
    const watch = watchExit(child);
    let stdout = "";
    let settled = false;
    const settle = (r: VersionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settle(versionFailed()); // the caller is released now; the kill below never holds it
      releaseStdout(child);
      void killGroup(child, watch, platform).then((exitedInTime) => {
        logger.warn(
          { tag: "agent-cli", op: "version_check_timeout", killed: 1, notExitedAfterKill: exitedInTime ? 0 : 1 },
          "the CLI's --version check timed out; its process group was killed",
        );
      });
    }, AGENT_CLI_VERSION_TIMEOUT_MS);
    timer.unref();
    let exitCode: number | null | undefined; // undefined until `exit`
    /** Exit 0 plus a version on a complete line: answered, whether or not stdout ever closes. */
    const settleIfAnsweredOnExit = (): void => {
      if (settled || exitCode !== 0) return;
      // Complete lines only: a version split across two chunks is never read half-way.
      if (parseFirstSemver(stdout.slice(0, stdout.lastIndexOf("\n") + 1)) === null) return;
      settle({ ok: true, stdout });
      releaseStdout(child);
      void endGroup(child, watch, 0, platform).then(({ signalled, exited }) => {
        if (!signalled) return;
        const fields = { tag: "agent-cli", op: "version_check_group_ended", killed: 1, notExitedAfterKill: exited ? 0 : 1 };
        // A CLI leaving a helper behind is not a fault, so ending it is debug. Only a survivor of SIGKILL is a warning.
        if (exited) logger.debug(fields, "the CLI's --version answered; what it left running was killed");
        else logger.warn(fields, "the CLI's --version answered; something it started survived SIGKILL");
      });
    };
    child.stdout?.on("data", (c: Buffer) => {
      if (!settled && stdout.length < VERSION_STDOUT_CAP) stdout += c.toString("utf8");
      settleIfAnsweredOnExit();
    });
    child.on("exit", (code: number | null) => {
      exitCode = code;
      settleIfAnsweredOnExit();
    });
    child.on("close", (code: number | null) => settle({ ok: code === 0, stdout }));
    child.on("error", () => settle(versionFailed()));
  });
}

/**
 * An injected `--version` runner under the same hard bound as the default one: a
 * runner that never settles, rejects or throws synchronously is `{ ok: false }`, and
 * neither the caller nor anyone sharing its in-flight resolution waits past it. The
 * default runner (`runCliVersion`) is not wrapped: it bounds itself, and an outer
 * timer started before its spawn would always fire first — reading a CLI that closes
 * in that gap as broken.
 */
function boundedVersion(run: () => Promise<VersionResult>): Promise<VersionResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: VersionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => settle(versionFailed()), AGENT_CLI_VERSION_TIMEOUT_MS);
    timer.unref();
    try {
      run().then(settle, () => settle(versionFailed()));
    } catch {
      settle(versionFailed());
    }
  });
}

/** `fs.realpathSync`, or the path itself when it cannot be resolved. */
function realpathFor(deps: ResolveAgentCliDeps): (p: string) => string {
  return (
    deps.realpath ??
    ((p: string) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    })
  );
}

function defaultMtime(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Found results only (usable / below minimum / broken). A null is never
 * memoized, so an install that lands between two status polls shows on the next
 * one — the login-shell probe's own 5 s memo bounds the spawn cost.
 */
const memo = new Map<SetupAgentId, { at: number; value: Exclude<ResolvedAgentCli, null>; realPath: string; mtime: number | null }>();
/** One resolution per agent at a time — a cold status call, provider detection and a session start share it. */
const inflight = new Map<SetupAgentId, Promise<ResolvedAgentCli>>();
/**
 * Per agent, bumped by invalidate: a resolution that started before it must not write
 * its (stale) result back. Per agent, so invalidating one never discards the other's.
 */
const generation = new Map<SetupAgentId, number>();
const generationOf = (agentId: SetupAgentId): number => generation.get(agentId) ?? 0;

/** Drops the memo (one agent, or all) and any in-flight result, so the next call resolves afresh. */
export function invalidateAgentCliMemo(agentId?: SetupAgentId): void {
  const ids = agentId ? [agentId] : (Object.keys(CLI_BIN_NAME) as SetupAgentId[]);
  for (const id of ids) {
    generation.set(id, generationOf(id) + 1);
    memo.delete(id);
    inflight.delete(id);
  }
}

export function resolveAgentCli(agentId: SetupAgentId, deps: ResolveAgentCliDeps = {}): Promise<ResolvedAgentCli> {
  if (!deps.holdEventLoop) return resolveUnheld(agentId, deps);
  // Taken before the resolution starts, so the loop is held from the probe's spawn on.
  const hold = setTimeout(() => {}, AGENT_CLI_RESOLVE_HOLD_MS);
  return resolveUnheld(agentId, deps).finally(() => clearTimeout(hold));
}

async function resolveUnheld(agentId: SetupAgentId, deps: ResolveAgentCliDeps): Promise<ResolvedAgentCli> {
  const now = deps.now ?? Date.now;
  const mtimeOf = deps.mtimeOf ?? defaultMtime;
  const hit = memo.get(agentId);
  if (hit) {
    const mtime = mtimeOf(hit.realPath);
    // The found path must still lead to the same file. An updater that repoints a versioned
    // symlink leaves the old target in place with its mtime intact, so the mtime alone would keep
    // reporting the old version ("update needed") for the rest of the memo window. A null mtime
    // (the stat failed) proves nothing about the file, so it is never fresh — even against a memo
    // written while the stat also failed, which would otherwise keep serving a vanished binary.
    const fresh =
      now() - hit.at < AGENT_CLI_MEMO_MS &&
      mtime !== null &&
      mtime === hit.mtime &&
      realpathFor(deps)(hit.value.path) === hit.realPath;
    if (fresh) return hit.value;
    // `staleOk` serves only a usable memo whose binary is still there. A vanished binary would
    // spawn an adapter pointed at a path that no longer exists. A below-minimum or broken result
    // would refuse the start, and record `not-installed`, from data the user may just have fixed
    // (an update, or an in-place reinstall that keeps the realPath).
    if (deps.staleOk && mtime !== null && isUsableCli(hit.value)) {
      // Session start never waits on the probe or --version when a memo exists, and a failed
      // refresh is never thrown at it — but it is logged. No error text: it can carry paths.
      void startResolve(agentId, deps).catch(() => {
        logger.warn(
          { tag: "agent-cli", op: "background_refresh_failed", agentId },
          "background refresh of the user's CLI failed; the previous result is still served",
        );
      });
      return hit.value;
    }
  }
  return startResolve(agentId, deps);
}

function startResolve(agentId: SetupAgentId, deps: ResolveAgentCliDeps): Promise<ResolvedAgentCli> {
  const running = inflight.get(agentId);
  if (running) return running;
  const gen = generationOf(agentId);
  const p = doResolve(agentId, deps, gen).finally(() => {
    if (inflight.get(agentId) === p) inflight.delete(agentId);
  });
  inflight.set(agentId, p);
  return p;
}

async function doResolve(agentId: SetupAgentId, deps: ResolveAgentCliDeps, gen: number): Promise<ResolvedAgentCli> {
  const now = deps.now ?? Date.now;
  const mtimeOf = deps.mtimeOf ?? defaultMtime;
  const platform = deps.platform ?? process.platform;
  const realpath = realpathFor(deps);
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, "utf-8"));
  const searchDirs =
    deps.searchDirs ??
    (async () => {
      const test = testAgentCliDirs();
      if (test) return test;
      const login = await (deps.loginShellPathDirs ?? (() => loginShellPathDirs({ platform })))();
      const own = (deps.processPathDirs ?? (() => (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)))();
      const known = deps.knownDirs ?? knownInstallDirs(agentId, platform, os.homedir());
      return [...login, ...own, ...known];
    });
  const dirs = await searchDirs();
  const findOpts = { searchDirs: dirs, realpath, libiRoots: deps.libiRoots ?? libiTreeRoots(), platform };
  const baseIsExecutable = deps.isExecutable ?? defaultIsExecutable;
  // On Windows a native .exe ANYWHERE in the search order beats a .cmd shim in an earlier
  // folder. `findUserCli` loops folders outside spellings, so run an .exe-only pass first.
  let found: UserCliSource = { kind: "none" };
  if (platform === "win32") {
    found = findUserCli([CLI_BIN_NAME[agentId]], {
      ...findOpts,
      isExecutable: (p) => /\.exe$/i.test(p) && baseIsExecutable(p),
    });
  }
  if (found.kind !== "user") {
    found = findUserCli([CLI_BIN_NAME[agentId]], { ...findOpts, isExecutable: baseIsExecutable });
  }

  let value: ResolvedAgentCli = null;
  let realPath: string | null = null;
  if (found.kind === "user") {
    realPath = realpath(found.path);
    // What the adapter will exec — and so what `--version` must run. For a Windows Claude `.cmd`
    // that is the shim's TARGET (`.js` → through node, native `.exe` → directly): spawning the
    // `.cmd` itself fails with EINVAL. Codex keeps its real path.
    const execPath = execPathFor(agentId, realPath, platform, readFile);
    const shape = spawnViaNodeIfScript(agentId === "claude-code" ? execPath : realPath, realpath, readFile);
    const versionCmd = { command: shape.command, args: [...shape.args, "--version"] };
    const injected = deps.spawnVersion;
    const res = injected ? await boundedVersion(() => injected(versionCmd)) : await runCliVersion(versionCmd);
    const version = res.ok ? parseFirstSemver(res.stdout) : null;
    if (version === null) {
      value = { foundButBroken: true, path: found.path };
    } else {
      const minimum = (deps.minimum ?? AGENT_CLI_MIN_VERSION)[agentId];
      value = { path: found.path, realPath, execPath, version, meetsMinimum: satisfiesMinimum(version, minimum) };
    }
  }
  if (gen === generationOf(agentId)) {
    if (value !== null && realPath !== null) memo.set(agentId, { at: now(), value, realPath, mtime: mtimeOf(realPath) });
    else memo.delete(agentId); // not found: never memoized
  }
  const fields = {
    tag: "agent-cli", op: "resolve", agentId, found: found.kind,
    broken: value !== null && "foundButBroken" in value, version: value && "version" in value ? value.version : null,
  };
  // A missing CLI is never memoized, so it is re-resolved on every status poll: debug, not info.
  if (value === null) logger.debug(fields, "no user CLI found");
  else logger.info(fields, "resolved the user's CLI");
  return value;
}

/**
 * What the adapter is TOLD to exec.
 * Claude: a Windows `.cmd` shim becomes its TARGET — a `.js` target (older npm
 * shims; the Agent SDK runs a `.js` executable under node itself) or a native
 * `.exe` target (claude-code 2.1.267's shim runs `bin\claude.exe`, no `cli.js`).
 * Verified on Windows: the `.cmd` dies with `spawn EINVAL`, its target starts a
 * session. An unreadable shim falls back to the `.cmd`, whose `--version` then
 * fails → `foundButBroken`.
 * Codex: always the real path — codex-acp spawns `"${codexPath}" app-server`
 * with `shell: true` on win32, which also handles a path with spaces.
 */
function execPathFor(agentId: SetupAgentId, realPath: string, platform: NodeJS.Platform, readFile: (p: string) => string): string {
  if (agentId !== "claude-code" || platform !== "win32" || !/\.cmd$/i.test(realPath)) return realPath;
  return resolveCmdShimTarget(realPath, readFile) ?? resolveCmdShimNativeTarget(realPath, readFile) ?? realPath;
}

/** A regular file with the execute bit (POSIX) / that exists (Windows — X_OK is an existence check there). */
function defaultIsExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
