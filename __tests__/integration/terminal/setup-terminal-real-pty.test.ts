/**
 * The unit suite drives the terminal manager with a fake PTY, so nothing there
 * proves a REAL shell leaves the command typed-but-not-run. This file spawns
 * the known setup shell through node-pty and checks exactly that, that it is
 * the known shell even when `$SHELL` names another one, and that closing the
 * terminal ends the shell process.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TerminalManager } from "@/lib/terminal/manager";
import { realPtyFactory } from "@/lib/terminal/pty";
import type { AttachedSocket, PtyFactory } from "@/lib/terminal/types";

/** Minimal socket: collects frames, runs close handlers (mirrors the unit FakeSocket). */
class CollectSocket implements AttachedSocket {
  sent: Array<string | Uint8Array> = [];
  bufferedAmount = 0;
  private handlers = new Map<string, Array<(arg?: unknown) => void>>();
  send(d: string | Uint8Array) {
    this.sent.push(d);
  }
  close() {
    for (const cb of this.handlers.get("close") ?? []) cb();
  }
  on(event: "message" | "close", cb: (arg?: unknown) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
  }
  emitMessage(raw: string) {
    for (const cb of this.handlers.get("message") ?? []) cb(Buffer.from(raw));
  }
  text(): string {
    return this.sent.map((d) => (typeof d === "string" ? d : Buffer.from(d).toString("utf8"))).join("");
  }
}

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const HAS_SHELL = existsSync("/bin/bash") && process.platform !== "win32";
let tmp: string | undefined;
let manager: TerminalManager | undefined;
const pids: number[] = [];
const prev = { HOME: process.env.HOME, ZDOTDIR: process.env.ZDOTDIR, SHELL: process.env.SHELL };

/** The command line `ps` reports for a pid, or "" when `ps` finds no such process. */
function commandOf(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return ""; // ps exits 1 for a pid it cannot find
  }
}

afterEach(async () => {
  // Whatever an assertion left behind, no shell outlives the test.
  for (const meta of manager?.list("setup") ?? []) manager?.close(meta.id);
  for (const pid of pids.splice(0)) {
    if (alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  manager = undefined;
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe.skipIf(!HAS_SHELL)("setup terminal over a real pty", () => {
  it("types initialInput without executing it, and close() ends the PTY", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "libi-setup-pty-"));
    tmp = dir;
    // The known setup shell is a LOGIN shell — keep the user's real profile out of it.
    process.env.HOME = dir;
    process.env.ZDOTDIR = dir;
    // A chat terminal would spawn this; a setup terminal must ignore it.
    process.env.SHELL = "/bin/sh";
    const recordingFactory: PtyFactory = (opts) => {
      const pty = realPtyFactory(opts);
      pids.push(pty.pid);
      return pty;
    };
    manager = new TerminalManager(recordingFactory, { cwd: () => dir });
    const marker = path.join(dir, "ran");
    const meta = manager.create({ cliId: "shell", purpose: "setup", surface: "agents", initialInput: `touch ${marker}` });
    const pid = pids[0];
    expect(alive(pid)).toBe(true);
    // This is a real host spawn, so the expected known shell follows the real host OS.
    const knownShell = os.platform() === "darwin" ? "/bin/zsh" : "/bin/bash";
    // Read right after spawn, `ps` can still show the command line from before the exec (on
    // Linux the forked child is briefly still this node process), so wait for the shell's own.
    const knownShellLine = new RegExp(`^${knownShell} -l`);
    expect(await until(() => knownShellLine.test(commandOf(pid)), 5_000)).toBe(true);
    expect(commandOf(pid)).toMatch(knownShellLine);

    const socket = new CollectSocket();
    await manager.attach(meta.id, socket);
    // The input is held until the first resize, so size the grid like a real view.
    socket.emitMessage(JSON.stringify({ type: "resize", cols: 200, rows: 30 }));
    expect(await until(() => socket.text().includes(`touch ${marker}`), 5_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(marker)).toBe(false); // typed, NOT executed — no Enter was sent

    expect(manager.close(meta.id)).toBe(true);
    expect(manager.list("setup")).toEqual([]);
    expect(await until(() => !alive(pid), 5_000)).toBe(true);
  }, 20_000);
});
