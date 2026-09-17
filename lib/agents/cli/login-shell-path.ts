import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { serverLogger as logger } from "@/lib/logger";
import { GROUP_EXIT_WAIT_MS, GROUP_KILL_GRACE_MS, endGroup, killGroup, releaseStdout, watchExit } from "./process-group";

/**
 * The login shell's PATH, fresh, non-blocking: an unref'd child and stdout, a
 * bounded listen. ONE attempt — unlike the desktop probe
 * (`electron/path-bootstrap.ts`) it never retries; it serves one resolver call.
 * Memoized in memory for 5 s so a 3 s status poll cannot spawn a shell per tick.
 * Never on disk. Windows: no login shell — the caller uses the process PATH.
 *
 * Unref'd means nothing waits for it unless something else holds the event loop:
 * a one-shot process (`libi connect`) must ask `resolveAgentCli` for
 * `holdEventLoop`, or Node exits before the answer arrives.
 *
 * The probe succeeds the moment the complete marker-framed PATH has arrived — it
 * does not wait for the pipe to close, which a profile's background job that
 * inherited stdout can hold open forever. The shell then gets
 * LOGIN_SHELL_PROBE_EXIT_CHANCE_MS to exit on its own before its process group is
 * ended (SIGTERM → 500 ms → SIGKILL → ≤ 1 s exit wait), so nothing its profile
 * started outlives the probe. None of that holds the caller.
 *
 * A timed-out probe is killed, never left hanging: the shell runs in its OWN
 * process group (`detached: true`), so on timeout SIGTERM reaches the shell AND
 * everything its profile started; SIGKILL follows 500 ms later; then the probe
 * waits at most 1 s for the shell's `exit` and for its group to empty. A process
 * still there is counted (`notExitedAfterKill`) and the caller gets `[]`
 * regardless — 3.5 s after the spawn at the very worst, never later. An
 * incomplete capture is never applied.
 *
 * The kill sequence lives in `process-group.ts`, a parallel implementation of the
 * desktop probe's (see that module for why nothing is shared with `electron/`).
 */
export const LOGIN_SHELL_PROBE_TIMEOUT_MS = 2_000;
/** SIGTERM → SIGKILL, both to the probe's process group. */
export const LOGIN_SHELL_PROBE_KILL_GRACE_MS = GROUP_KILL_GRACE_MS;
/** After SIGKILL: how long the shell's `exit` and its group emptying may take before what is left is counted (`notExitedAfterKill`) and left behind. */
export const LOGIN_SHELL_PROBE_EXIT_WAIT_MS = GROUP_EXIT_WAIT_MS;
/** After the complete capture the shell is normally mid-exit: how long it gets to exit on its own before its group is signalled. */
export const LOGIN_SHELL_PROBE_EXIT_CHANCE_MS = 250;
const MEMO_MS = 5_000;
const START = "__LIBI_PATH_START__";
const END = "__LIBI_PATH_END__";

export interface LoginShellPathDeps {
  spawn?: typeof nodeSpawn;
  platform?: NodeJS.Platform;
  now?: () => number;
}

let memo: { at: number; dirs: string[] } | null = null;
let inflight: Promise<string[]> | null = null;

export function __clearLoginShellPathMemo(): void {
  memo = null;
  inflight = null;
}

/** The PATH entries between the two markers; null unless BOTH markers are present. */
export function parsePathProbe(stdout: string): string[] | null {
  const s = stdout.indexOf(START);
  if (s < 0) return null;
  const e = stdout.indexOf(END, s + START.length);
  if (e < 0) return null;
  return stdout.slice(s + START.length, e).split(":").filter(Boolean);
}

function shellFor(platform: NodeJS.Platform): string {
  return process.env.SHELL || (platform === "linux" ? "/bin/bash" : "/bin/zsh");
}

export async function loginShellPathDirs(deps: LoginShellPathDeps = {}): Promise<string[]> {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return [];
  const now = deps.now ?? Date.now;
  if (memo && now() - memo.at < MEMO_MS) return memo.dirs;
  if (inflight) return inflight;
  const spawn = deps.spawn ?? nodeSpawn;
  const shell = shellFor(platform);
  inflight = new Promise<string[]>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(shell, ["-ilc", `printf ${START}; printf %s "$PATH"; printf ${END}`], {
        stdio: ["ignore", "pipe", "ignore"],
        detached: true, // its own process group, so a timeout can end everything the profile started
      });
    } catch {
      // Counts-only logging: no shell, no path, no error text.
      logger.warn({ tag: "agent-cli", op: "login_shell_probe_error" }, "login-shell PATH probe failed to spawn");
      resolve([]);
      return;
    }
    child.unref();
    (child.stdout as { unref?: () => void } | null)?.unref?.();
    const watch = watchExit(child);
    // Decoded across chunks: a multi-byte character split between two chunks stays intact.
    const decoder = new StringDecoder("utf8");
    let out = "";
    let settled = false;
    /** Answer the caller now, then end whatever the profile left running in the group. */
    const settle = (dirs: string[], op: string, exitChanceMs: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logger.debug({ tag: "agent-cli", op, dirs: dirs.length }, "login-shell PATH probe settled");
      resolve(dirs);
      releaseStdout(child);
      void endGroup(child, watch, exitChanceMs).then(({ signalled, exited }) => {
        if (!signalled) return;
        const fields = { tag: "agent-cli", op: "login_shell_probe_group_ended", killed: 1, notExitedAfterKill: exited ? 0 : 1 };
        // A profile that backgrounds work is normal, so ending it is debug. Only a survivor of SIGKILL is a warning.
        if (exited) logger.debug(fields, "login-shell PATH probe settled; what its profile left running was killed");
        else logger.warn(fields, "login-shell PATH probe settled; something its profile started survived SIGKILL");
      });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; // from here on, late output, `close` and `error` are ignored
      releaseStdout(child);
      void killGroup(child, watch).then((exitedInTime) => {
        logger.warn(
          { tag: "agent-cli", op: "login_shell_probe_timeout", killed: 1, notExitedAfterKill: exitedInTime ? 0 : 1 },
          "login-shell PATH probe timed out; its process group was killed",
        );
        resolve([]);
      });
    }, LOGIN_SHELL_PROBE_TIMEOUT_MS);
    timer.unref();
    child.stdout?.on("data", (c: Buffer) => {
      if (settled) return;
      out += decoder.write(c);
      // Both markers: the frame is final — later output cannot change what it holds.
      const dirs = parsePathProbe(out);
      if (dirs !== null) settle(dirs, "login_shell_probe_done", LOGIN_SHELL_PROBE_EXIT_CHANCE_MS);
    });
    child.on("close", () => {
      // The shell has exited: nothing left to give a chance to. Without both markers nothing is applied.
      const dirs = parsePathProbe(out + decoder.end());
      settle(dirs ?? [], dirs ? "login_shell_probe_done" : "login_shell_probe_incomplete", 0);
    });
    child.on("error", () => {
      if (settled) return; // e.g. the `error` a failed kill can raise after the timeout
      settled = true;
      clearTimeout(timer);
      logger.debug({ tag: "agent-cli", op: "login_shell_probe_error", dirs: 0 }, "login-shell PATH probe settled");
      resolve([]);
    });
  }).then((dirs) => {
    memo = { at: now(), dirs };
    inflight = null;
    return dirs;
  });
  return inflight;
}
