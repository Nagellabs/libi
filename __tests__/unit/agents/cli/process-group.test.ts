// Ending a timed-out check's whole process tree (lib/agents/cli/process-group.ts). POSIX signals the child's process
// group; Windows has none, so there the tree is ended with `taskkill /T /F /PID <pid>` (PRV-4) — before, only the CLI
// itself died there and whatever it started was left running. The platform is passed explicitly, so these read the
// same on any host; the last case runs the real thing and only on Windows (the QA VM).
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { endGroup, killGroup, taskkillTree, watchExit } from "@/lib/agents/cli/process-group";

function fakeChild(pid: number | undefined = 4242): ChildProcess & { exit: () => void } {
  const child = new EventEmitter() as ChildProcess & { exit: () => void };
  Object.assign(child, { pid, kill: vi.fn(() => true) });
  child.exit = () => child.emit("exit", null, "SIGTERM");
  return child;
}

describe("killGroup on Windows", () => {
  it("ends the child's whole tree with taskkill, then waits for its exit", async () => {
    const child = fakeChild();
    const watch = watchExit(child);
    const treeKill = vi.fn(async () => {
      queueMicrotask(() => child.exit());
      return true;
    });
    expect(await killGroup(child, watch, "win32", treeKill)).toBe(true);
    expect(treeKill).toHaveBeenCalledWith(4242);
    expect(child.kill).not.toHaveBeenCalled();
  });

  // Review I1: an exited child's pid may already be another process's; taskkill /T /F would end that whole tree.
  it("never tree-kills a child that already exited (its pid may be reused)", async () => {
    const child = fakeChild();
    const watch = watchExit(child);
    child.exit();
    const treeKill = vi.fn(async () => true);
    expect(await killGroup(child, watch, "win32", treeKill)).toBe(true);
    expect(treeKill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to killing the child itself when taskkill could not", async () => {
    const child = fakeChild();
    const watch = watchExit(child);
    (child.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
      queueMicrotask(() => child.exit());
      return true;
    });
    expect(await killGroup(child, watch, "win32", async () => false)).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("endGroup: a child that already exited has no tree left to walk; a live one gets taskkill", async () => {
    const gone = fakeChild();
    const goneWatch = watchExit(gone);
    gone.exit();
    const treeKill = vi.fn(async () => true);
    expect(await endGroup(gone, goneWatch, 0, "win32", treeKill)).toEqual({ signalled: false, exited: true });
    expect(treeKill).not.toHaveBeenCalled();

    const live = fakeChild(99);
    const liveWatch = watchExit(live);
    treeKill.mockImplementation(async () => {
      queueMicrotask(() => live.exit());
      return true;
    });
    expect(await endGroup(live, liveWatch, 0, "win32", treeKill)).toEqual({ signalled: true, exited: true });
    expect(treeKill).toHaveBeenCalledWith(99);
  });
});

describe("taskkillTree", () => {
  it("runs `taskkill /T /F /PID <pid>` hidden, and says whether it succeeded", async () => {
    const calls: Array<{ cmd: string; args: readonly string[]; opts: unknown }> = [];
    const fakeSpawn = ((cmd: string, args: readonly string[], opts: unknown) => {
      calls.push({ cmd, args, opts });
      const tk = new EventEmitter() as ChildProcess;
      Object.assign(tk, { unref: vi.fn() });
      const code = calls.length === 1 ? 0 : 128;
      queueMicrotask(() => tk.emit("exit", code, null));
      return tk;
    }) as unknown as typeof spawn;
    expect(await taskkillTree(123, fakeSpawn)).toBe(true);
    expect(await taskkillTree(124, fakeSpawn)).toBe(false);
    expect(calls[0]).toEqual({ cmd: "taskkill", args: ["/T", "/F", "/PID", "123"], opts: { stdio: "ignore", windowsHide: true } });
  });

  it("is false, not a throw, when taskkill can't be started", async () => {
    const throwing = (() => {
      throw new Error("spawn taskkill ENOENT");
    }) as unknown as typeof spawn;
    expect(await taskkillTree(1, throwing)).toBe(false);
  });
});

describe.runIf(process.platform === "win32")("killGroup on a real Windows host", () => {
  it("a timed-out CLI takes its children with it", async () => {
    // A parent that starts a long-lived child and prints its pid, as a `.cmd` shim's node would.
    const script =
      "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
      "console.log(c.pid);setInterval(()=>{},1000);";
    const parent = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const watch = watchExit(parent);
    const grandchild = await new Promise<number>((resolve) => parent.stdout!.once("data", (d) => resolve(Number(String(d).trim()))));
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(grandchild)).toBe(true);
    expect(await killGroup(parent, watch, "win32")).toBe(true);
    await vi.waitFor(() => expect(alive(grandchild)).toBe(false), { timeout: 5_000 });
  }, 15_000);
});
