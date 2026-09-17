// electron/path-bootstrap.ts
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { getLibiBinDir, getLibiHome } from "../lib/libi-home";
import { mainSyncLog } from "./sync-log";

/**
 * When macOS launches an .app via Finder / `open`, the process inherits
 * launchd's environment — which has a minimal PATH like
 * `/usr/bin:/bin:/usr/sbin:/sbin` and none of the variables the user's
 * profile exports. Homebrew, proto, nvm etc. are invisible, and so is
 * anything an agent or a provider CLI expects to find in the environment.
 *
 * Libi's own subprocess needs (npm, ffmpeg, yt-dlp, uv) DO NOT depend on
 * this anymore:
 *   - `npm` is vendored — see `lib/install/npm-root.ts`, which runs
 *     `node_modules/npm/bin/npm-cli.js` under a real Node child. No system
 *     npm required. (`lib/mcp/bundled-install.ts`, the original caller,
 *     was deleted on 2026-09-08; the runtime agent install is the caller now.)
 *   - `ffmpeg`, `ffprobe`, `yt-dlp`, `uv` live under `~/.libi/bin/`, which
 *     `buildSpawnEnv` always prepends.
 *
 * This module exists for everything else the desktop app spawns — the
 * user's agent CLIs above all — so they see the environment the user's own
 * terminal would give them. Same trick as sindresorhus/fix-path and
 * VS Code / Cursor.
 *
 * ## Why this is structured the way it is
 *
 * `bootstrapPath()` used to shell out via `execSync(..., { timeout: 2000 })`
 * to ask the user's login shell for its PATH, synchronously, before
 * returning. That is NOT SAFE: a timeout only protects you against a child
 * that is merely slow. It does nothing for a child that is blocked inside
 * the kernel — which is what was actually observed on a packaged boot that
 * hung for 10+ minutes. The spawned `/bin/zsh` sat inside a macOS
 * TCC/sandbox authorization IPC that never got a reply; `execSync`'s
 * `SIGTERM` cannot dequeue a process parked in that wait, so the 2000ms
 * timeout fired against something it couldn't kill and `spawnSync` kept
 * blocking. (This is a DIFFERENT mechanism from — and does not resurrect — the
 * previously-disproven "execSync blocks on a grandchild holding the stdout
 * pipe open" theory; that one really doesn't happen, this one does.)
 *
 * The fix is not a bigger or smarter timeout — no timeout can save you from
 * an OS that never answers. Instead:
 *
 *   1. `bootstrapPath()` applies a known-good PATH (the libi-bin dir, plus
 *      either a cached previously-discovered shell PATH or the hardcoded
 *      fallback locations) SYNCHRONOUSLY before it does anything else, and
 *      returns. Nothing in this step can block, because none of it asks
 *      the OS for anything that might not answer.
 *   2. It then starts the login-shell probe — on EVERY launch, warm cache or
 *      not, in the BACKGROUND, and it is NEVER awaited:
 *      `bootstrapPath()` returns before the first attempt can answer, and
 *      `electron/main.ts` ignores the `probeSettled` handle. The probe runs
 *      `$SHELL -ilc 'printf <start>; env -0; printf <end>'` via `spawn`
 *      (async — it never blocks the caller) and reads the shell's WHOLE
 *      environment: PATH gets the prepend merge below, every other variable
 *      is imported add-only (a variable already set keeps its value) and
 *      never from the blocklist (`isBlockedEnvName`). The environment is never
 *      written to disk — the cache keeps PATH only. The child, its stdout
 *      pipe and every timer are `unref()`'d as defense-in-depth against a
 *      SEPARATE failure mode — a hung attempt keeping the Node event loop
 *      referenced (see `runProbeAttempt`).
 *   3. An attempt succeeds the moment a usable capture has arrived — both
 *      markers AND a non-empty PATH entry, read from stdout's raw bytes and
 *      decoded once (a multi-byte character split across chunks stays intact).
 *      It does not wait for the pipe to close, which a profile's background job
 *      that inherited stdout can hold open forever. A complete frame without a
 *      PATH (`env -0` unsupported, `env` aliased) is an incomplete capture.
 *      Every attempt that settles on its output — success or incomplete — then
 *      ends its process group: a shell that has not exited yet gets
 *      SHELL_PROBE_EXIT_CHANCE_MS to exit on its own, then SIGTERM goes to the
 *      group (reaching only survivors once the shell has exited) and SIGKILL
 *      500 ms later. A group already gone (ESRCH, the usual case — and ONLY
 *      ESRCH: a member that refuses the signal with EPERM still exists) counts
 *      and waits for nothing; one that had to be signalled counts as
 *      `killedAfterSuccess` after a success (never a failure) and as `killed`
 *      after an incomplete capture. An attempt fails on its 2 s timeout, a spawn
 *      error, or an incomplete capture, and is retried after 1 / 2 / 4 / 8 s —
 *      five attempts at most, then `failed` until the next launch. Each
 *      attempt runs in its own process group (`detached: true`); a timed-out
 *      attempt gets SIGTERM to that group, then SIGKILL 500 ms later, and the
 *      next attempt starts only after its `exit` and its group has emptied
 *      (re-checked within the same exit wait, since a SIGKILLed member lingers
 *      until it is reaped). A process that survives SIGKILL — the shell, or
 *      any member of its group — is counted (`notExitedAfterKill`) and blocks
 *      nothing. Once an attempt settles, our end of its stdout is closed. The
 *      recorded TCC hang only ever measured SIGTERM failing. The state
 *      is published as `LIBI_SHELL_ENV` (`pending` | `loaded` | `failed`) for
 *      the runtime; a profile cannot set it, because `LIBI_*` is never
 *      imported. Logs carry counts only.
 *
 * The PATH cache lives at `<LIBI_HOME>/shell-path-cache.json`, resolved via
 * `getLibiHome()` so it lands in the right place for both the packaged app
 * (`~/Library/Application Support/libi`) and the CLI (`~/.libi`) — never
 * hardcoded. It only lets a warm launch start with the user's PATH before
 * the probe answers; every launch re-probes and refreshes it.
 *
 * ## Late-apply ordering
 *
 * Every attempt that succeeds (or times out holding a complete PATH entry)
 * refines `process.env` after `bootstrapPath()` has already returned —
 * possibly after Category A has already spawned a subprocess or two using
 * the synchronous PATH, and possibly several seconds in when an earlier
 * attempt failed. This is intentional and safe: `child_process.spawn`/`execFile`/etc. read
 * `process.env` (or an explicit `env` you pass) at the moment THEY are
 * called, not once at process start. A subprocess already spawned before
 * the refinement keeps whatever environment it was given — it does not
 * retroactively break. Every subprocess spawned AFTER the refinement sees
 * the fuller, shell-discovered environment; the runtime reads
 * `LIBI_SHELL_ENV` to know which case a given spawn was. Losing a
 * login-shell-only directory or variable for the first subprocess or two of
 * a launch is an acceptable trade against never being able to hang boot on it.
 *
 * Idempotent: safe to call multiple times — a second call joins the running probe.
 */

export const SHELL_PROBE_TIMEOUT_MS = 2000;
/** Attempts per launch, and the wait before attempts 2, 3, 4 and 5. */
export const SHELL_PROBE_MAX_ATTEMPTS = 5;
export const SHELL_PROBE_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000];
/** SIGTERM to a timed-out attempt's process group, then SIGKILL after this grace. */
export const SHELL_PROBE_KILL_GRACE_MS = 500;
/** How long a SIGKILLed attempt may take to report `exit` before it is counted
 *  (`notExitedAfterKill`) and the loop moves on without it. */
export const SHELL_PROBE_EXIT_WAIT_MS = 1000;
/** After a complete capture the shell is normally mid-exit: how long it gets to exit on its own
 *  before its group is signalled, so a shell exiting normally is never counted as killed. */
export const SHELL_PROBE_EXIT_CHANCE_MS = 250;
/** Once a SIGKILLed attempt's shell has exited, how often its GROUP is re-checked for members
 *  within SHELL_PROBE_EXIT_WAIT_MS — a member the SIGKILL reached is normally reaped within
 *  milliseconds, so one answer taken at once would count a dying process as a survivor. */
export const SHELL_PROBE_GROUP_POLL_MS = 50;
/**
 * The shell→runtime seam: `pending` | `loaded` | `failed`, written ONLY here.
 * Absent (npx, dev, Windows) means the environment was inherited from a real shell.
 * Read by `lib/runtime/shell-env-state.ts` — the packaged Next server runs in this process.
 */
export const SHELL_ENV_STATE_VAR = "LIBI_SHELL_ENV";
const PATH_CACHE_FILENAME = "shell-path-cache.json";
export const ENV_START_MARKER = "__LIBI_ENV_START__";
export const ENV_END_MARKER = "__LIBI_ENV_END__";
/** The end marker is ASCII, so a byte search for it on the raw UTF-8 stream is exact. */
const ENV_END_MARKER_BYTES = Buffer.from(ENV_END_MARKER, "utf8");

interface ShellPathCache {
  shell: string;
  path: string;
}

/**
 * Never imported from the login shell. Exact names and
 * prefixes. `PATH` is not here because it has its own prepend-merge path.
 */
const BLOCKED_ENV_EXACT = new Set([
  "NODE_OPTIONS", "NODE_PATH", "NODE_ENV", "PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV",
  "PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID", "FNM_MULTISHELL_PATH",
]);
const BLOCKED_ENV_PREFIXES = ["LIBI_", "ELECTRON_", "CONDA_", "DYLD_", "LD_", "TMUX", "BASH_FUNC_"];

export function isBlockedEnvName(name: string): boolean {
  if (BLOCKED_ENV_EXACT.has(name)) return true;
  return BLOCKED_ENV_PREFIXES.some((p) => name.startsWith(p));
}

export interface ParsedEnvProbe {
  /** Both markers seen — the whole environment was captured. */
  complete: boolean;
  /** NUL-terminated `KEY=VALUE` entries only; a cut-off trailing fragment is dropped. */
  entries: Array<[string, string]>;
  /** The complete PATH entry, when one was captured. */
  path: string | null;
}

/** Pure. See the test file for the framing cases this must satisfy. */
export function parseEnvProbeOutput(stdout: string): ParsedEnvProbe {
  const start = stdout.indexOf(ENV_START_MARKER);
  if (start < 0) return { complete: false, entries: [], path: null };
  const bodyStart = start + ENV_START_MARKER.length;
  const end = stdout.indexOf(ENV_END_MARKER, bodyStart);
  const complete = end >= 0;
  const body = complete ? stdout.slice(bodyStart, end) : stdout.slice(bodyStart);
  const parts = body.split("\0");
  // The last piece is either "" (body ended on a NUL) or a fragment cut mid-value
  // by the timeout; either way it is not an entry.
  parts.pop();
  const entries: Array<[string, string]> = [];
  let path: string | null = null;
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    entries.push([key, value]);
    if (key === "PATH") path = value;
  }
  return { complete, entries, path };
}

/**
 * A capture worth applying: both markers AND a non-empty PATH entry. A complete frame without
 * one — `env -0` unsupported (nothing between the markers), `env` aliased to something that
 * prints no NULs, a profile that unset PATH — is an incomplete capture, and so a failure: a
 * login shell always has a PATH, and `loaded` must not be claimed for an environment never read.
 */
function isUsableCapture(parsed: ParsedEnvProbe): boolean {
  return parsed.complete && parsed.path !== null && parsed.path.trim().length > 0;
}

/** Add-only merge into `target`; PATH is skipped (mergePrepend owns it). Counts only. */
export function mergeShellEnv(
  entries: Array<[string, string]>,
  target: NodeJS.ProcessEnv,
): { added: number; blocked: number } {
  let added = 0;
  let blocked = 0;
  for (const [key, value] of entries) {
    if (key === "PATH") continue;
    if (isBlockedEnvName(key)) {
      blocked++;
      continue;
    }
    if (target[key] !== undefined) continue;
    target[key] = value;
    added++;
  }
  return { added, blocked };
}

/** `$SHELL`, else the platform's stock shell. */
export function probeShell(): string {
  if (process.env.SHELL) return process.env.SHELL;
  return process.platform === "linux" ? "/bin/bash" : "/bin/zsh";
}

/** Logs carry counts only: an error is logged by its code, never its message (which names the shell path). */
function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? "unknown";
}

/** One probe loop per process: a second `bootstrapPath()` joins it (idempotent). */
let activeProbe: { settled: Promise<void>; stop: () => void } | null = null;

/**
 * Applies a usable PATH synchronously and starts the background probe (posix only).
 *
 * `probeSettled` resolves once the probe loop has reached `loaded` | `failed` AND the last
 * attempt's group termination has finished — which can be up to ~1.75 s after the state is
 * published (SHELL_PROBE_EXIT_CHANCE_MS + SHELL_PROBE_KILL_GRACE_MS + SHELL_PROBE_EXIT_WAIT_MS
 * when a group had to be killed; at once when it was already gone). It never resolves if
 * `stopShellEnvProbe()` cleared a timer that termination was waiting on. Already resolved on
 * win32. The app never awaits it; it exists for tests.
 */
export function bootstrapPath(): { probeSettled: Promise<void> } {
  const pathSep = process.platform === "win32" ? ";" : ":";
  // The libi-bin dir is always prepended first so libi-managed binaries shadow
  // any system versions. Resolved via `getLibiBinDir()`, NOT a hardcoded
  // `~/.libi/bin`: the packaged app's home is `~/Library/Application Support/libi`,
  // and hardcoding put the DEVELOPER's bin dir on the packaged app's PATH while
  // the app's own binaries (including the node Category A provisions) stayed invisible.
  const libiBin = getLibiBinDir();
  const posix = process.platform === "darwin" || process.platform === "linux";

  if (posix) {
    const cached = readCachedShellPath();
    if (cached) {
      // Warm path: apply the cached PATH synchronously so Category A never
      // waits on the shell — but the probe below STILL runs (on every
      // launch): the cache holds PATH only, and the rest of the environment
      // is re-read live, in the background.
      mergePrepend([libiBin, ...splitUnique(cached, pathSep)], pathSep);
      return { probeSettled: startShellEnvProbe(libiBin, pathSep) };
    }
  }

  const fallback: string[] = [libiBin];
  if (posix) {
    fallback.push(
      "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin",
      "/usr/bin", "/bin", "/usr/sbin", "/sbin",
    );
  } else if (process.platform === "win32") {
    const home = process.env.USERPROFILE ?? "";
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    fallback.push(
      path.join(localAppData, "Programs", "nodejs"),
      path.join(home, "AppData", "Roaming", "npm"),
      "C:\\Program Files\\nodejs",
    );
  }
  mergePrepend(fallback, pathSep);

  if (!posix) return { probeSettled: Promise.resolve() };
  return { probeSettled: startShellEnvProbe(libiBin, pathSep) };
}

/**
 * Stop a running probe loop: clears its pending timers so nothing fires later.
 * Kills nothing. Exists for tests (a module per test must not leave a retry
 * timer behind); nothing in the app calls it.
 */
export function stopShellEnvProbe(): void {
  activeProbe?.stop();
  activeProbe = null;
}

/** How an attempt's group termination went. `signalled` = SIGTERM found a group with members;
 *  `exited` = the shell exited AND no member of its group was left once the exit wait was up. */
interface Termination {
  signalled: boolean;
  exited: boolean;
}

type AttemptResult =
  | {
      ok: true;
      added: number;
      blocked: number;
      /** The succeeded attempt's group termination. */
      terminated: Promise<Termination>;
    }
  | { ok: false; cause: "timeout"; pathApplied: boolean; exited: boolean }
  | { ok: false; cause: "error"; code: string }
  | ({ ok: false; cause: "incomplete" } & Termination);

/**
 * Read the login shell's whole environment in the BACKGROUND. Up to
 * SHELL_PROBE_MAX_ATTEMPTS attempts; each fails on its timeout, a spawn error or
 * an incomplete capture, and is retried after SHELL_PROBE_BACKOFF_MS. The state
 * is published as SHELL_ENV_STATE_VAR; logs carry counts only.
 */
function startShellEnvProbe(libiBin: string, pathSep: string): Promise<void> {
  if (activeProbe) return activeProbe.settled;
  const shell = probeShell();
  const startedAt = Date.now();
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;
  const later = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(() => {
        timers.delete(t);
        resolve();
      }, ms);
      t.unref();
      timers.add(t);
    });

  process.env[SHELL_ENV_STATE_VAR] = "pending";
  // Logs carry counts only — never the $SHELL value, a path, a name or a value.
  mainSyncLog("path-bootstrap: shell_env_probe_start");

  let attempts = 0;
  let failures = 0;
  let killed = 0;
  let killedAfterSuccess = 0;
  let notExitedAfterKill = 0;
  const finish = (state: "loaded" | "failed", added = 0, blocked = 0): void => {
    process.env[SHELL_ENV_STATE_VAR] = state;
    mainSyncLog(
      `path-bootstrap: shell_env_probe_done state=${state} attempts=${attempts} failures=${failures} killed=${killed} killedAfterSuccess=${killedAfterSuccess} notExitedAfterKill=${notExitedAfterKill} added=${added} blocked=${blocked} ms=${Date.now() - startedAt}`,
    );
  };

  // The first attempt spawns synchronously, inside this call; bootstrapPath() still
  // returns at once — nothing here waits for the shell to answer.
  const settled = (async () => {
    for (;;) {
      attempts++;
      const result = await runProbeAttempt(shell, libiBin, pathSep, later, timers);
      if (stopped) return;
      // `=== true`, not truthiness: electron/tsconfig.json is non-strict, where only an
      // equality check narrows this union.
      if (result.ok === true) {
        // Loaded now — the environment is already merged; the log waits for the termination.
        process.env[SHELL_ENV_STATE_VAR] = "loaded";
        const termination = await result.terminated;
        if (stopped) return;
        if (termination.signalled) {
          killedAfterSuccess++;
          if (!termination.exited) notExitedAfterKill++;
        }
        finish("loaded", result.added, result.blocked);
        return;
      }
      failures++;
      let detail = "";
      if (result.cause === "timeout") {
        killed++;
        if (!result.exited) notExitedAfterKill++;
        detail = ` pathApplied=${result.pathApplied} exited=${result.exited}`;
      } else if (result.cause === "error") {
        detail = ` code=${result.code}`;
      } else if (result.cause === "incomplete" && result.signalled) {
        // Something the profile started outlived the shell and had to be killed.
        killed++;
        if (!result.exited) notExitedAfterKill++;
        detail = ` killed=true exited=${result.exited}`;
      }
      mainSyncLog(
        `path-bootstrap: shell_env_probe_attempt_failed attempt=${attempts} cause=${result.cause}${detail}`,
      );
      if (attempts >= SHELL_PROBE_MAX_ATTEMPTS) {
        finish("failed");
        return;
      }
      await later(SHELL_PROBE_BACKOFF_MS[attempts - 1]);
      if (stopped) return;
    }
  })();

  activeProbe = {
    settled,
    stop: () => {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
  return settled;
}

/**
 * One attempt, in its OWN process group (`detached: true`), so a timeout can end
 * the shell AND everything its profile started. The child and its stdout pipe are
 * unref'd so a hung attempt never holds the event loop open.
 */
function runProbeAttempt(
  shell: string,
  libiBin: string,
  pathSep: string,
  later: (ms: number) => Promise<void>,
  timers: Set<NodeJS.Timeout>,
): Promise<AttemptResult> {
  return new Promise<AttemptResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(shell, ["-ilc", `printf ${ENV_START_MARKER}; env -0; printf ${ENV_END_MARKER}`], {
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
      });
    } catch (err) {
      resolve({ ok: false, cause: "error", code: errCode(err) });
      return;
    }
    child.unref();
    // Raw bytes, decoded ONCE when the capture is read: a multi-byte character split across
    // two chunks would otherwise decode as U+FFFD on each side and be imported (and PATH
    // cached) corrupted.
    const chunks: Buffer[] = [];
    /** The last few bytes seen, so an end marker split across chunks is still found. */
    let tail = Buffer.alloc(0);
    const captured = (): string => Buffer.concat(chunks).toString("utf8");
    let settled = false;
    let exited = false;
    const onExit: Array<() => void> = [];
    const markExited = (): void => {
      exited = true;
      for (const fn of onExit.splice(0)) fn();
    };
    child.on("exit", markExited);
    /** True as soon as the shell has exited; otherwise whether it had after `ms`. */
    const waitForExit = (ms: number): Promise<boolean> =>
      exited
        ? Promise.resolve(true)
        : Promise.race([
            new Promise<boolean>((r) => onExit.push(() => r(true))),
            later(ms).then(() => exited),
          ]);
    /**
     * After SIGTERM: the grace, SIGKILL to the group, then ≤ SHELL_PROBE_EXIT_WAIT_MS for the shell's
     * `exit` AND for its group to empty. True only when both happened in time; a shell or a member
     * still there when the wait is up is a survivor — counted by the caller, never waited for longer.
     */
    const killAfterGrace = async (): Promise<boolean> => {
      await later(SHELL_PROBE_KILL_GRACE_MS);
      // Always: a profile's background job can outlive a shell that exited on SIGTERM.
      signalGroup(child, "SIGKILL");
      const deadline = Date.now() + SHELL_PROBE_EXIT_WAIT_MS;
      if (!(await waitForExit(SHELL_PROBE_EXIT_WAIT_MS))) return false;
      // The shell is gone, but a background job of its profile may not be. A member the SIGKILL
      // reached still shows up until it is reaped, so re-check instead of trusting one answer.
      while (groupHasMembers(child)) {
        const left = deadline - Date.now();
        if (left <= 0) return false;
        await later(Math.min(SHELL_PROBE_GROUP_POLL_MS, left));
      }
      return true;
    };
    /**
     * Still our probe once it has settled: end whatever the profile left running in the group.
     * A shell that has not exited yet first gets `exitChanceMs` to finish on its own — right
     * after printing its capture it is normally mid-exit, and signalling it then would count a
     * kill that never had to happen. Once it has exited, the SIGTERM reaches only survivors (a
     * background job holding the pipe open, a `daemon >/dev/null &`); a group that is already
     * gone (ESRCH — the usual case) has nothing to count and nothing to wait for.
     */
    const terminateGroup = async (exitChanceMs: number): Promise<Termination> => {
      if (exitChanceMs > 0) await waitForExit(exitChanceMs);
      // Only ESRCH is "gone": a member that refused the signal (EPERM) still exists.
      if (signalGroup(child, "SIGTERM") === "gone") return { signalled: false, exited: true };
      return { signalled: true, exited: await killAfterGrace() };
    };
    /** A usable capture arrived: merge and succeed now, whether or not the pipe ever closes. */
    const succeed = (parsed: ParsedEnvProbe, exitChanceMs: number): void => {
      settled = true;
      clearTimeout(timer);
      timers.delete(timer);
      if (parsed.path !== null) applyPath(parsed.path, shell, libiBin, pathSep);
      const { added, blocked } = mergeShellEnv(parsed.entries, process.env);
      releaseStdout(child);
      resolve({ ok: true, added, blocked, terminated: terminateGroup(exitChanceMs) });
    };
    /** No usable capture: apply nothing, end the group, then fail. */
    const failIncomplete = (exitChanceMs: number): void => {
      settled = true;
      clearTimeout(timer);
      timers.delete(timer);
      releaseStdout(child);
      // A profile's `daemon >/dev/null &` may outlive the shell: end the group exactly as a
      // success or a timeout does before the attempt counts as failed.
      void terminateGroup(exitChanceMs).then((t) => resolve({ ok: false, cause: "incomplete", ...t }));
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      timers.delete(timer);
      // Timed out: trust ONLY a complete PATH entry, import nothing else.
      const parsed = parseEnvProbeOutput(captured());
      const pathApplied = parsed.path !== null;
      if (parsed.path !== null) applyPath(parsed.path, shell, libiBin, pathSep);
      releaseStdout(child);
      signalGroup(child, "SIGTERM");
      void killAfterGrace().then((exitedInTime) =>
        resolve({ ok: false, cause: "timeout", pathApplied, exited: exitedInTime }),
      );
    }, SHELL_PROBE_TIMEOUT_MS);
    timer.unref();
    timers.add(timer);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      chunks.push(chunk);
      // Only the new chunk plus the bytes just before it can hold an end marker not already
      // looked for — no re-scan (or re-decode) of the whole capture per chunk.
      const window = Buffer.concat([tail, chunk]);
      tail = Buffer.from(window.subarray(Math.max(0, window.length - (ENV_END_MARKER_BYTES.length - 1))));
      // Success is the complete capture, not the pipe closing (both markers are still required).
      if (!window.includes(ENV_END_MARKER_BYTES)) return;
      const parsed = parseEnvProbeOutput(captured());
      // Both markers: the frame is final — later output cannot change what it holds.
      if (!parsed.complete) return;
      if (isUsableCapture(parsed)) succeed(parsed, SHELL_PROBE_EXIT_CHANCE_MS);
      else failIncomplete(SHELL_PROBE_EXIT_CHANCE_MS);
    });
    unrefStdout(child);

    child.on("close", () => {
      // Node emits `close` only after the process has exited: nothing left to give a chance to.
      markExited();
      if (settled) return; // a timed-out attempt's late output is never applied
      const parsed = parseEnvProbeOutput(captured());
      // Applied ONLY from a usable capture: a shell that closed early with an incomplete
      // one applies nothing, not even PATH.
      if (isUsableCapture(parsed)) succeed(parsed, 0);
      else failIncomplete(0);
    });
    child.on("error", (err) => {
      if (settled) return; // e.g. the `error` a failed kill can raise after the timeout
      settled = true;
      clearTimeout(timer);
      timers.delete(timer);
      releaseStdout(child);
      resolve({ ok: false, cause: "error", code: errCode(err) });
    });
  });
}

/**
 * What a signal to a whole attempt — its shell and every process its profile started — found.
 * `gone`: no process left in the group (ESRCH). `denied`: a member exists but refused the signal
 * (EPERM) — it is still there, so it is never taken for gone.
 */
type GroupSignal = "sent" | "gone" | "denied";

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): GroupSignal {
  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return "sent";
    }
    return child.kill(signal) === true ? "sent" : "gone";
  } catch (err) {
    return errCode(err) === "ESRCH" ? "gone" : "denied";
  }
}

/**
 * Whether the attempt's group still has a member — the shell or anything its profile started.
 * Signal 0 checks without signalling. Only ESRCH means empty: EPERM names a member that exists
 * (on macOS that includes a group whose only member is a zombie not yet reaped).
 */
function groupHasMembers(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (err) {
    return errCode(err) !== "ESRCH";
  }
}

/** Merge + cache a complete PATH value. Cache = `{ shell, path }` and nothing else. */
function applyPath(shellPath: string, shell: string, libiBin: string, pathSep: string): void {
  const trimmed = shellPath.trim();
  if (trimmed.length === 0) return;
  mergePrepend([libiBin, ...splitUnique(trimmed, pathSep)], pathSep);
  writeCachedShellPath(shell, trimmed);
}

function readCachedShellPath(): string | null {
  try {
    const raw = fs.readFileSync(pathCacheFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<ShellPathCache>;
    if (typeof parsed.path === "string" && parsed.path.length > 0 && parsed.shell === probeShell()) {
      return parsed.path;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Node types `ChildProcess.stdout` as a generic `Readable`, which has no
 * `unref()` — but with `stdio: ["ignore", "pipe", "ignore"]` the object at
 * runtime is always a pipe handle (a `net.Socket`-like stream) that DOES
 * have one. Narrow locally instead of reaching for `any`.
 */
interface UnrefableStream {
  unref?: () => void;
}

function unrefStdout(child: ChildProcess): void {
  (child.stdout as UnrefableStream | null)?.unref?.();
}

/**
 * A settled attempt reads nothing more: close our end of its stdout. Without this a profile's job
 * that escaped the group and still holds the pipe keeps our read end, its buffer and the `data`
 * listener alive for the app's lifetime — and never sees EPIPE, so it keeps writing into it.
 */
function releaseStdout(child: ChildProcess): void {
  child.stdout?.destroy();
}

/** Merge `prepend` (in order) ahead of the current `process.env.PATH`, de-duped. */
function mergePrepend(prepend: string[], pathSep: string): void {
  const original = process.env.PATH ?? "";
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of [...prepend, ...splitUnique(original, pathSep)]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    merged.push(dir);
  }
  process.env.PATH = merged.join(pathSep);
}

function splitUnique(p: string, sep: string): string[] {
  return p.split(sep).filter((s) => s.length > 0);
}

function pathCacheFile(): string {
  return path.join(getLibiHome(), PATH_CACHE_FILENAME);
}

/**
 * Best-effort cache write. Never throws — a failed write only costs the
 * next boot a re-probe, it must never affect the CURRENT boot.
 */
function writeCachedShellPath(shell: string, shellPath: string): void {
  try {
    const home = getLibiHome();
    fs.mkdirSync(home, { recursive: true });
    const cache: ShellPathCache = { shell, path: shellPath };
    fs.writeFileSync(pathCacheFile(), JSON.stringify(cache), "utf8");
  } catch {
    /* best-effort — ignore */
  }
}
