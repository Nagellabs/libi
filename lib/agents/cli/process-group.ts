import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

/**
 * Ending a short-lived check's whole process group. The login-shell PATH probe and
 * the `--version` check both spawn `detached: true`, so the child leads its own
 * group and a signal to `-pid` reaches everything it started — a profile's
 * background job, a wrapper's child. Every wait here is an unref'd timer: a check
 * being killed never holds the server's event loop open, and no caller ever waits
 * on a kill.
 *
 * Windows has no process groups. There the whole TREE is ended instead:
 * `taskkill /T /F /PID <pid>` walks the child's descendants, so a timed-out CLI
 * takes what it started with it (a `.cmd` shim's node, the node's own children).
 * It needs the child alive to find them — once a parent is gone its orphans can't
 * be walked — so a check that already exited has nothing left to reach there,
 * and is never tree-killed: its pid may already belong to another process.
 * Even for a live child, `/T` finds descendants by their recorded parent pid, so
 * it could also take orphans of an EARLIER process that had the same pid. A Job
 * Object would be the robust alternative if that ever matters.
 *
 * PARALLEL IMPLEMENTATION, on purpose. `electron/path-bootstrap.ts` (`signalGroup`
 * and its kill sequence) does the same for the desktop probe, but runtime code may
 * not import `electron/` and `electron/` may not import runtime code (AGENTS.md
 * "Desktop shell vs runtime"). Nothing is shared across that boundary: when one
 * changes, change the other by hand.
 */

/** SIGTERM → SIGKILL, both to the group. */
export const GROUP_KILL_GRACE_MS = 500;
/**
 * After SIGKILL: how long the child's `exit` AND the emptying of its whole group may
 * take before what is left is counted (`notExitedAfterKill`) and left behind.
 */
export const GROUP_EXIT_WAIT_MS = 1_000;
/** Within the exit wait: how often the group is re-checked for members. */
export const GROUP_POLL_MS = 50;

/**
 * What a signal to the group found. `gone`: nothing left to signal (ESRCH).
 * `denied`: a member exists but refused the signal (EPERM) — still there, so never
 * taken for gone.
 */
export type GroupSignal = "sent" | "gone" | "denied";

export interface ExitWatch {
  exited(): boolean;
  /** True as soon as the child has exited; otherwise whether it had after `ms`. */
  waitForExit(ms: number): Promise<boolean>;
}

/** Tracks the child's exit from the moment it is spawned, so a later wait never misses it. */
export function watchExit(child: ChildProcess): ExitWatch {
  let exited = false;
  const waiters: Array<() => void> = [];
  const markExited = (): void => {
    exited = true;
    for (const fn of waiters.splice(0)) fn();
  };
  child.on("exit", markExited);
  // Node emits `close` only after the process has exited.
  child.on("close", markExited);
  return {
    exited: () => exited,
    waitForExit: (ms) =>
      exited
        ? Promise.resolve(true)
        : Promise.race([
            new Promise<boolean>((r) => {
              waiters.push(() => r(true));
            }),
            sleepMs(ms).then(() => exited),
          ]),
  };
}

/**
 * Signal the child's whole process group. A child without a pid — or any child on
 * Windows, which has no process groups — is signalled directly.
 */
export function signalGroup(child: ChildProcess, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): GroupSignal {
  try {
    if (child.pid !== undefined && platform !== "win32") {
      process.kill(-child.pid, signal);
      return "sent";
    }
    return child.kill(signal) === true ? "sent" : "gone";
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === "ESRCH" ? "gone" : "denied";
  }
}

/**
 * Whether the child's group still has a member — the child or anything it started.
 * Signal 0 checks without signalling. Only ESRCH means empty: success or EPERM names
 * a member that exists (on macOS a group whose only member is a zombie not yet reaped
 * answers EPERM). A child without a pid, or any child on Windows, has no group to
 * check: false.
 */
export function groupHasMembers(child: ChildProcess, platform: NodeJS.Platform = process.platform): boolean {
  if (child.pid === undefined || platform === "win32") return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code !== "ESRCH";
  }
}

/**
 * Called right after SIGKILL: at most GROUP_EXIT_WAIT_MS for the child's `exit` and
 * then for its whole group to empty. True only when both happened in time. The child
 * exiting is not the end: a member SIGKILL reached still shows until it is reaped, so
 * the group is re-checked every GROUP_POLL_MS instead of trusting one answer — and
 * never past the same budget.
 */
async function waitForGroupGone(child: ChildProcess, watch: ExitWatch, platform?: NodeJS.Platform): Promise<boolean> {
  const deadline = Date.now() + GROUP_EXIT_WAIT_MS;
  if (!(await watch.waitForExit(GROUP_EXIT_WAIT_MS))) return false;
  while (groupHasMembers(child, platform)) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await sleepMs(Math.min(GROUP_POLL_MS, left));
  }
  return true;
}

/** Ends a process and every process it started; resolves whether that was done. */
export type TreeKill = (pid: number) => Promise<boolean>;

/**
 * `taskkill /T /F /PID <pid>`: the process and its whole tree, forcibly (Windows has
 * no graceful signal to send a console program from here). Bounded at
 * GROUP_EXIT_WAIT_MS and unref'd like every wait in this module; true only when
 * taskkill exited 0.
 */
export function taskkillTree(pid: number, spawnFn: typeof nodeSpawn = nodeSpawn): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), GROUP_EXIT_WAIT_MS);
    timer.unref();
    let tk: ChildProcess;
    try {
      tk = spawnFn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    } catch {
      done(false);
      return;
    }
    tk.unref();
    tk.on("error", () => done(false));
    tk.on("exit", (code) => done(code === 0));
  });
}

/**
 * Windows: the child's whole tree via taskkill, falling back to the child alone; then at most GROUP_EXIT_WAIT_MS for
 * its `exit`. A child that has already exited is never tree-killed: Node closed its handle, so Windows may already
 * have given its pid to an unrelated process, and `taskkill /T /F` would end that process and everything under it.
 */
async function killTree(child: ChildProcess, watch: ExitWatch, treeKill: TreeKill): Promise<boolean> {
  if (watch.exited()) return true;
  const killed = child.pid !== undefined && (await treeKill(child.pid));
  if (!killed) signalGroup(child, "SIGKILL", "win32");
  return watch.waitForExit(GROUP_EXIT_WAIT_MS);
}

/**
 * A check that ran out of time: SIGTERM to the group → (grace) → SIGKILL to the
 * group, then at most GROUP_EXIT_WAIT_MS for the child's `exit` and its group to
 * empty; resolves whether both happened in time. SIGKILL always follows the grace,
 * even when the child already exited on SIGTERM — something it started can outlive it.
 * Windows: its whole tree at once (`taskkillTree`), then the same exit wait.
 */
export async function killGroup(
  child: ChildProcess,
  watch: ExitWatch,
  platform: NodeJS.Platform = process.platform,
  treeKill: TreeKill = taskkillTree,
): Promise<boolean> {
  if (platform === "win32") return killTree(child, watch, treeKill);
  signalGroup(child, "SIGTERM", platform);
  await sleepMs(GROUP_KILL_GRACE_MS);
  signalGroup(child, "SIGKILL", platform);
  return waitForGroupGone(child, watch, platform);
}

/**
 * A check that already has its answer: end whatever is left in its group. A child
 * that has not exited yet first gets `exitChanceMs` to finish on its own — right
 * after printing its answer it is normally mid-exit. Then SIGTERM goes to the group
 * (once the child has exited it reaches only what it left behind); a group that is
 * already gone (the usual case) is done. Otherwise SIGKILL follows the grace and
 * the exit wait applies to the child and its whole group. `signalled` says whether
 * anything had to be killed; `exited`, whether nothing survived.
 */
export async function endGroup(
  child: ChildProcess,
  watch: ExitWatch,
  exitChanceMs: number,
  platform: NodeJS.Platform = process.platform,
  treeKill: TreeKill = taskkillTree,
): Promise<{ signalled: boolean; exited: boolean }> {
  if (exitChanceMs > 0) await watch.waitForExit(exitChanceMs);
  if (platform === "win32") {
    // Exited: its tree can't be walked any more, and there is nothing of its own left to end.
    if (watch.exited()) return { signalled: false, exited: true };
    return { signalled: true, exited: await killTree(child, watch, treeKill) };
  }
  if (signalGroup(child, "SIGTERM", platform) === "gone") return { signalled: false, exited: true };
  await sleepMs(GROUP_KILL_GRACE_MS);
  signalGroup(child, "SIGKILL", platform);
  return { signalled: true, exited: await waitForGroupGone(child, watch, platform) };
}

/** Releases our end of the child's stdout: something it left behind may hold the other end open. */
export function releaseStdout(child: ChildProcess): void {
  (child.stdout as { destroy?: () => void } | null)?.destroy?.();
}

/** An unref'd wait: a check being killed never holds the server's event loop open. */
export function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms).unref();
  });
}
