/**
 * Run as its OWN node process (through tsx) by
 * `__tests__/unit/agents/cli/resolve-hold-event-loop.test.ts`: whether a
 * pending promise keeps a process alive can only be observed in a process that
 * nothing else holds open — a vitest worker always is.
 *
 * It resolves a CLI the way the one-shot `libi connect` does, through the real
 * `resolveAgentCli` and the real `loginShellPathDirs`, with only the shell
 * spawn faked. The fake child is what the real probe makes of a real shell: its
 * handle and its stdout are unref'd, so neither holds the event loop — modelled
 * by answering from an unref'd timer. Nothing else is found (no PATH, no known
 * folders), so no `--version` child is ever spawned.
 *
 * argv[2]: `hold-answer` | `nohold-answer` | `hold-hang`.
 * Prints ONE JSON line on stdout when the process is about to go idle:
 * `{ settled, dirs, found, settleToIdleMs }`.
 */
import { EventEmitter } from "node:events";
import type { spawn as nodeSpawn } from "node:child_process";
import { resolveAgentCli } from "@/lib/agents/cli/resolve";
import { loginShellPathDirs } from "@/lib/agents/cli/login-shell-path";

const mode = process.argv[2] ?? "hold-answer";
const answers = mode !== "hold-hang";

function fakeSpawn(): EventEmitter {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdout = Object.assign(new EventEmitter(), { unref: () => {}, destroy: () => {} });
  let exited = false;
  const exit = (): void => {
    if (exited) return;
    exited = true;
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");
  };
  Object.assign(child, {
    pid: undefined, // no process group: the probe signals the child itself
    stdout,
    unref: () => {}, // the real probe unrefs the child: it must not be what holds the loop
    kill: (signal: string) => {
      if (signal === "SIGKILL") setImmediate(exit);
      return true;
    },
  });
  if (answers) {
    setTimeout(() => {
      stdout.emit("data", Buffer.from("__LIBI_PATH_START__/fake/bin:/usr/bin__LIBI_PATH_END__"));
      exit();
    }, 30).unref();
  }
  return child;
}

let settled = false;
let dirs: string[] | null = null;
let found: boolean | null = null;
let settledAt = 0;
let reported = false;

process.on("beforeExit", () => {
  if (reported) return;
  reported = true;
  process.stdout.write(
    `${JSON.stringify({ settled, dirs, found, settleToIdleMs: settled ? Date.now() - settledAt : null })}\n`,
  );
});

void (async () => {
  const r = await resolveAgentCli("claude-code", {
    holdEventLoop: mode !== "nohold-answer",
    loginShellPathDirs: async () => {
      dirs = await loginShellPathDirs({ platform: "darwin", spawn: fakeSpawn as unknown as typeof nodeSpawn });
      return dirs;
    },
    processPathDirs: () => [],
    knownDirs: [],
    libiRoots: [],
    platform: "darwin",
  });
  settled = true;
  settledAt = Date.now();
  found = r !== null;
})();
