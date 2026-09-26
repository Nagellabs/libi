/**
 * Y5: two libis sharing one `bin/` (dev worktrees link it) coordinate the
 * install of a dependency through an O_EXCL lock file next to it
 * (mcp/registry/install-lock.ts). The lock itself is tested directly; the last
 * block drives DependencyManager.retryDep against a REAL second process that
 * holds the lock and installs uv, and checks that libi waits and then does not
 * install it again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/lib/analytics/server", () => ({ trackServerEvent: vi.fn() }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("../../../helpers/test-db");
  const db = createTestDb();
  return { getDb: () => db };
});
const transitions: Array<{ mcpId: string; binary: string; patch: Record<string, unknown> }> = [];
vi.mock("@/mcp/registry/dep-transition", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/registry/dep-transition")>()),
  writeDepTransition: (mcpId: string, binary: string, patch: Record<string, unknown>) =>
    transitions.push({ mcpId, binary, patch }),
}));

import {
  acquireInstallLock,
  acquireInstallLocks,
  InstallLockTimeoutError,
} from "@/mcp/registry/install-lock";
import { serverLogger } from "@/lib/logger";
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { exeSuffix } from "@/lib/platform";

const savedHome = process.env.LIBI_HOME;
let home: string;
let lockPath: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-install-lock-"));
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  process.env.LIBI_HOME = home;
  lockPath = path.join(home, "bin", "uv.install-lock");
  transitions.length = 0;
  // A system uv on PATH would count as installed (resolveStatus's `which`
  // fallback) and decide the cross-process cases; pin "not on PATH".
  vi.spyOn(
    DependencyManager.prototype as unknown as { binaryExistsOnPath: () => boolean },
    "binaryExistsOnPath",
  ).mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

/** A lock file as another process would leave it. */
function foreignLock(pid: number, ageMs = 0): void {
  fs.writeFileSync(lockPath, JSON.stringify({ pid, startedAt: new Date().toISOString() }));
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(lockPath, t, t);
  }
}

const settled = async (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);

describe("acquireInstallLock", () => {
  it("creates the lock with this pid, and release removes it", async () => {
    const lock = await acquireInstallLock(lockPath);
    expect(lock.waited).toBe(false);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf-8"))).toMatchObject({ pid: process.pid });
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("waits while a live process holds it, then takes it", async () => {
    foreignLock(999_999);
    const pending = acquireInstallLock(lockPath, { pollMs: 10, isAlive: () => true });
    expect(await settled(pending, 100)).toBe(false);
    fs.rmSync(lockPath);
    const lock = await pending;
    expect(lock.waited).toBe(true);
    lock.release();
  });

  it("takes over a lock whose owner is dead, without waiting", async () => {
    foreignLock(999_999);
    const lock = await acquireInstallLock(lockPath, { pollMs: 10, isAlive: () => false });
    expect(lock.waited).toBe(false);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf-8")).pid).toBe(process.pid);
    lock.release();
  });

  it("takes over a lock whose heartbeat stopped, even if its pid is running (pid reuse)", async () => {
    foreignLock(999_999, 10 * 60_000);
    const lock = await acquireInstallLock(lockPath, { pollMs: 10, isAlive: () => true });
    expect(lock.waited).toBe(false);
    lock.release();
  });

  it("takes over a leftover lock naming this pid that this process does not hold", async () => {
    foreignLock(process.pid);
    const lock = await acquireInstallLock(lockPath, { pollMs: 10 });
    expect(lock.waited).toBe(false);
    lock.release();
  });

  it("the holder's heartbeat keeps the lock fresh", async () => {
    const lock = await acquireInstallLock(lockPath, { heartbeatMs: 20 });
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lockPath, old, old);
    await new Promise((r) => setTimeout(r, 80));
    expect(Date.now() - fs.statSync(lockPath).mtimeMs).toBeLessThan(5_000);
    lock.release();
  });

  it("release leaves a lock that is now someone else's", async () => {
    const lock = await acquireInstallLock(lockPath);
    foreignLock(999_999);
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("never removes a stale-looking lock that was replaced after it was judged", async () => {
    foreignLock(111);
    // Judging 111 dead is the moment another waiter takes it over with its own lock.
    const isAlive = (pid: number) => {
      if (pid === 111) {
        fs.writeFileSync(lockPath, JSON.stringify({ pid: 222, startedAt: "later" }));
        return false;
      }
      return true; // 222 is alive
    };
    const pending = acquireInstallLock(lockPath, { pollMs: 10, isAlive });
    expect(await settled(pending, 100)).toBe(false);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf-8")).pid).toBe(222);
    fs.rmSync(lockPath);
    (await pending).release();
  });

  it("gives up on a live owner after the wait cap, with a plain error and a log line", async () => {
    foreignLock(999_999);
    const warn = vi.spyOn(serverLogger, "warn");
    const err = await acquireInstallLock(lockPath, { pollMs: 10, maxWaitMs: 50, isAlive: () => true }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(InstallLockTimeoutError);
    expect(err!.message).toMatch(/^Another libi on this computer has been installing uv for over \d+ minutes\./);
    expect(warn.mock.calls.some((c) => (c[0] as { op?: string }).op === "install_lock_wait_timeout")).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true); // theirs, left alone
  });

  it("on Windows retries a transient create error, then takes the lock", async () => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    const real = fs.openSync;
    let failures = 2;
    vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (flags === "wx" && failures-- > 0) {
        throw Object.assign(new Error("EPERM: operation not permitted, open"), { code: "EPERM" });
      }
      return real(p, flags, mode);
    }) as typeof fs.openSync);
    const lock = await acquireInstallLock(lockPath);
    expect(failures).toBeLessThan(0);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf-8")).pid).toBe(process.pid);
    lock.release();
  });

  it("elsewhere, a create error is not retried: the install goes ahead unlocked", async () => {
    vi.spyOn(os, "platform").mockReturnValue("linux");
    const open = vi.spyOn(fs, "openSync").mockImplementation((() => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    }) as typeof fs.openSync);
    const lock = await acquireInstallLock(lockPath);
    expect(lock.waited).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
    lock.release();
  });

  it("an unwritable directory proceeds unlocked rather than failing the install", async () => {
    const lock = await acquireInstallLock(path.join(home, "no-such-dir", "x.install-lock"));
    expect(lock.waited).toBe(false);
    lock.release();
  });

  it("several locks are taken in sorted order, and all released", async () => {
    const a = path.join(home, "bin", "a.install-lock");
    const b = path.join(home, "bin", "b.install-lock");
    const both = await acquireInstallLocks([b, a, b]);
    expect(fs.existsSync(a) && fs.existsSync(b)).toBe(true);
    both.release();
    expect(fs.existsSync(a) || fs.existsSync(b)).toBe(false);
  });
});

// The whole point: another libi (a real second process) is installing uv into
// the shared bin/. retryDep must wait for it and then NOT download uv again.
// Runs on every host: the files are named the way the product names them —
// `uv.exe`, `uv.exe.install-token`, `uv.exe.install-lock` on Windows (exeSuffix()).
describe("retryDep across processes", () => {
  let child: ChildProcess | null = null;
  afterEach(() => {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    child = null;
  });

  const uvToken = () =>
    BUNDLED_MCP_SERVERS.flatMap((d) => d.dependencies).find((x) => x.binary === "uv")!.pinnedInstallToken!;
  /** uv's file name in bin/, as the product spells it on this host. */
  const UV = `uv${exeSuffix()}`;

  /** A second process that takes the lock, "installs" uv after `ms`, then releases. */
  function otherLibiInstallingUv(ms: number, install = true): Promise<void> {
    const bin = path.join(home, "bin");
    const script = `
      const fs = require("fs"), path = require("path");
      const bin = ${JSON.stringify(bin)};
      const uv = ${JSON.stringify(UV)};
      const lock = path.join(bin, uv + ".install-lock");
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
      process.stdout.write("locked\\n");
      setTimeout(() => {
        if (${install}) {
          fs.writeFileSync(path.join(bin, uv), "#!/bin/sh\\n", { mode: 0o755 });
          fs.writeFileSync(path.join(bin, uv + ".install-token"), ${JSON.stringify(uvToken())});
        }
        fs.unlinkSync(lock);
        process.exit(0);
      }, ${ms});
    `;
    child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    return new Promise((resolve, reject) => {
      child!.stdout!.once("data", () => resolve());
      child!.once("exit", (code) => code !== 0 && reject(new Error(`helper exited ${code}`)));
    });
  }

  it("waits for the other install and does not repeat it", async () => {
    const download = vi
      .spyOn(DependencyManager.prototype as unknown as { downloadGroup: () => Promise<void> }, "downloadGroup")
      .mockResolvedValue(undefined);
    const info = vi.spyOn(serverLogger, "info");
    await otherLibiInstallingUv(400);
    await new DependencyManager().retryDep("youtube-download", "uv");
    const ops = info.mock.calls.map((c) => (c[0] as { op?: string }).op);
    expect(ops).toContain("install_lock_wait");
    expect(ops).toContain("dep_install_served_elsewhere");
    expect(download).not.toHaveBeenCalled();
    const last = transitions.filter((t) => t.mcpId === "youtube-download" && t.binary === "uv").at(-1);
    expect(last?.patch).toMatchObject({ installed: true });
  });

  it("installs itself when the other process released without installing", async () => {
    const download = vi
      .spyOn(DependencyManager.prototype as unknown as { downloadGroup: () => Promise<void> }, "downloadGroup")
      .mockImplementation(async () => {
        fs.writeFileSync(path.join(home, "bin", UV), "#!/bin/sh\n", { mode: 0o755 });
        fs.writeFileSync(path.join(home, "bin", `${UV}.install-token`), uvToken());
      });
    await otherLibiInstallingUv(200, false);
    await new DependencyManager().retryDep("youtube-download", "uv");
    expect(download).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(home, "bin", `${UV}.install-lock`))).toBe(false);
  });
});
