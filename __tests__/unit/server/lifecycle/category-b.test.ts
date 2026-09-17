import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runCategoryB,
  BootPhaseError,
  defaultCategoryBDeps,
  getMcpHttpChild,
  setMcpHttpChildForTests,
  MCP_TOOLS_UNAVAILABLE_WARNING,
} from "@/lib/server/lifecycle/category-b";
import { serverLogger } from "@/lib/logger";
import { lifecycleEvents } from "@/lib/server/lifecycle/events";
import { getLibiAgentDir } from "@/lib/libi-home";
import { stripLegacyAgentDirFiles } from "@/mcp/workspace";
import { runBootHousekeeping } from "@/lib/server/lifecycle/housekeeping";
import type { CategoryBDeps } from "@/lib/server/lifecycle/category-b";
import type { LifecycleEvent } from "@/lib/server/lifecycle/types";
import type { McpHttpChildHandle } from "@/lib/server/lifecycle/mcp-http-child";
import { getSettings } from "@/lib/db/settings";
import { getAgentConfig } from "@/lib/agents/acp/agent-registry";

// Stub out modules that would require a real DB / agent process in tests.
vi.mock("@/lib/db/settings", () => ({
  getSettings: vi.fn(() => ({ preferredAgent: null })),
}));
vi.mock("@/lib/agents/acp/agent-registry", () => ({
  getAgentConfig: vi.fn(() => null),
}));
// The user's CLI: never a real login-shell probe in a unit test.
const { resolveCli } = vi.hoisted(() => ({ resolveCli: vi.fn(async (): Promise<unknown> => null) }));
vi.mock("@/lib/agents/cli/resolve", () => ({
  resolveAgentCli: () => resolveCli(),
  isUsableCli: (r: { meetsMinimum?: boolean } | null) => !!r && "meetsMinimum" in r && r.meetsMinimum === true,
}));
vi.mock("@/lib/mcp-config", () => ({
  invalidateMcpConfig: vi.fn(),
}));
// The real supervisor is covered in mcp-http-child.test.ts; here only what
// Category B does with the handle it resolves.
const { startMcpHttpChild } = vi.hoisted(() => ({ startMcpHttpChild: vi.fn() }));
vi.mock("@/lib/server/lifecycle/mcp-http-child", () => ({ startMcpHttpChild }));
vi.mock("@/mcp/workspace", () => ({
  prepareAgentDir: vi.fn(async () => {}),
  stripLegacyAgentDirFiles: vi.fn(() => [] as string[]),
}));
// Category B fires the disk-housekeeping sweep for real: without this mock
// the suite would prune the developer's actual `~/Library/Caches/ms-playwright`.
vi.mock("@/lib/server/lifecycle/housekeeping", () => ({
  runBootHousekeeping: vi.fn(async () => {}),
}));

const baseDeps: CategoryBDeps = {
  migrateDatabase: () => {},
  recoverOrphanedJobs: async () => {},
  writePortFile: () => {},
  startMcpHttp: async () => {},
  prepareAgentDir: async () => {},
  warmAgentProcess: async () => {},
  loadSessions: async () => {},
  probeAndPersist: async () => {},
  createStandby: async () => {},
  syncSkillInstalls: async () => {},
};

describe("runCategoryB", () => {
  let events: LifecycleEvent[];
  let unsubscribe: () => void;

  beforeEach(() => {
    events = [];
    unsubscribe = lifecycleEvents.on((e) => events.push(e));
  });

  afterEach(() => {
    unsubscribe();
    vi.mocked(stripLegacyAgentDirFiles).mockReset().mockImplementation(() => []);
  });

  it("emits step events for db-migrate / jobs-recover / port-file in order", async () => {
    await runCategoryB(baseDeps);
    const steps = events
      .filter((e) => e.kind === "category-b-step")
      .map((e) => {
        const ev = e as Extract<LifecycleEvent, { kind: "category-b-step" }>;
        return `${ev.step}:${ev.status}`;
      });

    expect(steps).toContain("db-migrate:running");
    expect(steps).toContain("db-migrate:done");
    expect(steps.indexOf("db-migrate:done")).toBeLessThan(steps.indexOf("jobs-recover:running"));
    expect(steps.indexOf("jobs-recover:done")).toBeLessThan(steps.indexOf("port-file:running"));
    expect(steps.indexOf("port-file:done")).toBeLessThan(steps.indexOf("mcp-http:running"));
  });

  it("starts the MCP aggregator after the port file and before the agent dir", async () => {
    // Ordering is the contract: the aggregator child inherits the studio port
    // from `<LIBI_HOME>/port`, and `prepareAgentDir` writes agent config that
    // points at the aggregator — so it must already be up.
    const writePortFile = vi.fn();
    const startMcpHttp = vi.fn(async () => {});
    const prepareAgentDir = vi.fn<(dir: string) => Promise<void>>(async () => {});
    await runCategoryB({ ...baseDeps, writePortFile, startMcpHttp, prepareAgentDir });

    expect(startMcpHttp).toHaveBeenCalledOnce();
    expect(writePortFile.mock.invocationCallOrder[0]).toBeLessThan(
      startMcpHttp.mock.invocationCallOrder[0],
    );
    expect(startMcpHttp.mock.invocationCallOrder[0]).toBeLessThan(
      prepareAgentDir.mock.invocationCallOrder[0],
    );
  });

  it("throws BootPhaseError with a damaged-install hint when the aggregator cannot be launched at all", async () => {
    // A launch that could not even be attempted (the entry does not resolve,
    // the port picker threw) is a broken install, and stays fatal. A launch
    // that ran but never answered is not: see the gave-up test below.
    await expect(
      runCategoryB({
        ...baseDeps,
        startMcpHttp: async () => {
          throw new Error("did not become healthy");
        },
      }),
    ).rejects.toMatchObject({
      name: "BootPhaseError",
      step: "mcp-http",
      // Not "set LIBI_MCP_PORT": a busy port no longer reaches this step, since
      // a launch that runs and never answers ends gave-up instead.
      hint: expect.stringContaining("damaged install"),
    });
  });

  it("throws BootPhaseError on db-migrate failure with hint", async () => {
    await expect(
      runCategoryB({
        ...baseDeps,
        migrateDatabase: () => { throw new Error("malformed schema"); },
      }),
    ).rejects.toMatchObject({ name: "BootPhaseError", step: "db-migrate" });
  });

  it("never tells the user to delete their database", async () => {
    // The old hint was "Try `rm -rf ~/.libi/libi.sqlite*` to reset". It is the
    // first thing a stuck user runs, it is irreversible, and it is wrong for
    // every cause this step actually has. What replaces it points at the
    // automatic backups and, at worst, at MOVING the files aside.
    let hint = "";
    try {
      await runCategoryB({
        ...baseDeps,
        migrateDatabase: () => { throw new Error("malformed schema"); },
      });
    } catch (err) {
      hint = (err as { hint: string }).hint;
    }
    expect(hint).not.toMatch(/rm -rf/);
    expect(hint).toMatch(/libi\.sqlite\.backup-\*/);
    expect(hint).toMatch(/MOVE the files aside/i);
  });

  it("prefers a hint the ERROR carries over the step's generic one", async () => {
    // `DatabaseSchemaTooNewError` is the case where the step's own advice would
    // be actively harmful: the data is newer, not damaged.
    const err = Object.assign(new Error("older than the database"), {
      hint: "This copy of libi is older than your data.",
    });
    await expect(
      runCategoryB({ ...baseDeps, migrateDatabase: () => { throw err; } }),
    ).rejects.toMatchObject({
      name: "BootPhaseError",
      step: "db-migrate",
      hint: "This copy of libi is older than your data.",
    });
  });

  it("throws BootPhaseError on jobs-recover failure", async () => {
    await expect(
      runCategoryB({
        ...baseDeps,
        recoverOrphanedJobs: async () => { throw new Error("jobs dir corrupt"); },
      }),
    ).rejects.toMatchObject({ name: "BootPhaseError", step: "jobs-recover" });
  });

  it("calls prepareAgentDir exactly once, with getLibiAgentDir()", async () => {
    const prepared: string[] = [];
    await runCategoryB({
      ...baseDeps,
      prepareAgentDir: async (dir: string) => { prepared.push(dir); },
    });
    expect(prepared).toEqual([getLibiAgentDir()]);
  });

  it("starts the recorded-install sync right after prepareAgentDir, in the background", async () => {
    const order: string[] = [];
    let release!: () => void;
    const never = new Promise<void>((r) => { release = r; });
    await runCategoryB({
      ...baseDeps,
      prepareAgentDir: async () => { order.push("prepare"); },
      syncSkillInstalls: () => { order.push("sync"); return never; },
    });
    // Boot finished without waiting for the sync.
    expect(order).toEqual(["prepare", "sync"]);
    expect(events.some((e) => e.kind === "category-b-done")).toBe(true);
    release();
  });

  it("a rejecting install sync is logged, never a boot failure", async () => {
    const warn = vi.spyOn(serverLogger, "warn");
    const failure = Object.assign(new Error("EACCES: permission denied, open '/Users/me/private-project/.claude/skills'"), { code: "EACCES" });
    try {
      await expect(
        runCategoryB({ ...baseDeps, syncSkillInstalls: async () => { throw failure; } }),
      ).resolves.toBeUndefined();
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ tag: "skills", op: "installs_sync_at_boot_failed", err: { code: "EACCES", name: "Error" } }),
          expect.any(String),
        ),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does not abort boot when stripLegacyAgentDirFiles throws", async () => {
    // A legacy file that can't be removed (permissions, locked handle, etc.)
    // must never take the whole app down — Phase 2 logs and continues.
    vi.mocked(stripLegacyAgentDirFiles).mockImplementationOnce(() => {
      throw new Error("EPERM: operation not permitted");
    });
    const prepareAgentDir = vi.fn<(dir: string) => Promise<void>>(async () => {});

    await expect(runCategoryB({ ...baseDeps, prepareAgentDir })).resolves.toBeUndefined();
    expect(prepareAgentDir).toHaveBeenCalledOnce();
  });

  it("emits category-b-done on the happy path (no preferred agent)", async () => {
    // With baseDeps and no preferred agent in the test DB, Category B
    // skips Phase 3 onwards and emits category-b-done after the workspace
    // prep.
    await runCategoryB(baseDeps);
    expect(events.some((e) => e.kind === "category-b-done")).toBe(true);
  });

  it("publishes the mcp-http child handle on globalThis so a SEPARATE module instance sees it too", async () => {
    // Regression for the Turbopack dual-instance bug: instrumentation.ts and
    // app/api/mcp/health/route.ts can resolve `category-b` to different
    // module instances. A plain module-level `let` written by one instance
    // is invisible to the other; a `globalThis`-keyed slot is not.
    const fakeHandle: McpHttpChildHandle = {
      port: 41234,
      advertisedPort: 41234,
      publishedPort: 41234,
      ownsHealthAnswer: () => true,
      stop: async () => {},
      restart: async () => {},
      status: () => "running",
    };

    await runCategoryB({
      ...baseDeps,
      startMcpHttp: async () => {
        setMcpHttpChildForTests(fakeHandle);
      },
    });

    // Same module instance: the getter sees it directly.
    expect(getMcpHttpChild()).toBe(fakeHandle);

    // A fresh dynamic import — a distinct module instance, the way Turbopack
    // can produce one for instrumentation.ts vs. an API route — must still
    // resolve to the SAME handle because it lives on globalThis, not on
    // either instance's own module-level state.
    vi.resetModules();
    const reimported = await import("@/lib/server/lifecycle/category-b");
    expect(reimported.getMcpHttpChild()).toBe(fakeHandle);

    // Clean up: leave the shared globalThis slot as the other tests expect it.
    setMcpHttpChildForTests(null);
  });

  it("a first launch that gave up is not fatal: the gave-up handle is stored for health and Restart, and boot carries on", async () => {
    const restart = vi.fn(async () => {});
    const handle: McpHttpChildHandle = {
      port: 3457,
      advertisedPort: 3457,
      publishedPort: 3457,
      ownsHealthAnswer: () => true,
      stop: async () => {},
      restart,
      status: () => "gave-up",
    };
    startMcpHttpChild.mockResolvedValueOnce(handle);
    const error = vi.spyOn(serverLogger, "error");
    const prepareAgentDir = vi.fn(async () => {});

    await expect(
      runCategoryB({ ...baseDeps, startMcpHttp: defaultCategoryBDeps.startMcpHttp, prepareAgentDir }),
    ).resolves.toBeUndefined();

    // /api/mcp/health reads gave-up (not unknown), and /api/mcp/restart has a handle to restart.
    expect(getMcpHttpChild()).toBe(handle);
    expect(getMcpHttpChild()?.status()).toBe("gave-up");
    expect(prepareAgentDir).toHaveBeenCalledOnce();
    expect(events.some((e) => e.kind === "category-b-done")).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "mcp-http", op: "boot_start_gave_up" }),
      expect.stringMatching(/Restart/),
    );
    // The user hears it too, from the splash or the terminal: boot carries on,
    // so a warning rather than a fatal, and one that names the fix.
    expect(events).toContainEqual({
      kind: "warning",
      phase: "category-b",
      step: "mcp-http",
      message: MCP_TOOLS_UNAVAILABLE_WARNING,
    });
    expect(MCP_TOOLS_UNAVAILABLE_WARNING).toBe(
      "libi's tools are unavailable — open Agents → Libi MCP and press Restart.",
    );
    expect(events.some((e) => e.kind === "fatal")).toBe(false);

    error.mockRestore();
    setMcpHttpChildForTests(null);
  });

  it("a healthy first launch warns about nothing", async () => {
    startMcpHttpChild.mockResolvedValueOnce({
      port: 3457,
      advertisedPort: 3457,
      publishedPort: 3457,
      ownsHealthAnswer: () => true,
      stop: async () => {},
      restart: async () => {},
      status: () => "running",
    } satisfies McpHttpChildHandle);
    await runCategoryB({ ...baseDeps, startMcpHttp: defaultCategoryBDeps.startMcpHttp });
    expect(events.some((e) => e.kind === "warning")).toBe(false);
    setMcpHttpChildForTests(null);
  });

  it("stores the handle the moment the supervisor hands it out, so a quit during the first health wait can find the child to stop", async () => {
    const handle: McpHttpChildHandle = {
      port: 3457,
      advertisedPort: 3457,
      publishedPort: 3457,
      ownsHealthAnswer: () => true,
      stop: async () => {},
      restart: async () => {},
      status: () => "running",
    };
    let release!: () => void;
    const healthWait = new Promise<void>((r) => (release = r));
    let storedDuringWait: McpHttpChildHandle | null = null;
    startMcpHttpChild.mockImplementationOnce(async (deps: { onHandle?: (h: McpHttpChildHandle) => void }) => {
      deps.onHandle?.(handle);
      await healthWait;
      return handle;
    });
    const boot = runCategoryB({ ...baseDeps, startMcpHttp: defaultCategoryBDeps.startMcpHttp });
    await vi.waitFor(() => expect(getMcpHttpChild()).toBe(handle));
    storedDuringWait = getMcpHttpChild();
    release();
    await boot;
    expect(storedDuringWait).toBe(handle);
    setMcpHttpChildForTests(null);
  });
});

describe("runCategoryB housekeeping", () => {
  it("fires the boot housekeeping sweep without awaiting it", async () => {
    vi.mocked(runBootHousekeeping).mockClear();
    await runCategoryB(baseDeps);
    await vi.waitFor(() => expect(runBootHousekeeping).toHaveBeenCalledTimes(1));
  });
});

describe("runCategoryB — Phase 3 agent warm", () => {
  const USABLE = { path: "/u/bin/claude", realPath: "/u/bin/claude", execPath: "/u/bin/claude", version: "9.0.0", meetsMinimum: true };

  beforeEach(() => {
    vi.mocked(getSettings).mockReturnValue({ preferredAgent: "claude-code" } as never);
    vi.mocked(getAgentConfig).mockReturnValue({ installed: true } as never);
  });

  afterEach(() => {
    vi.mocked(getSettings).mockReturnValue({ preferredAgent: null } as never);
    vi.mocked(getAgentConfig).mockReturnValue(null as never);
    resolveCli.mockReset().mockResolvedValue(null);
  });

  it("skips the warm when the preferred agent's CLI does not resolve — the Agents tab is where that is fixed", async () => {
    resolveCli.mockResolvedValue(null);
    const warmAgentProcess = vi.fn(async () => {});
    await runCategoryB({ ...baseDeps, warmAgentProcess });
    expect(warmAgentProcess).not.toHaveBeenCalled();
  });

  it("warms the preferred agent when its adapter is installed and its CLI is usable", async () => {
    resolveCli.mockResolvedValue(USABLE);
    const warmAgentProcess = vi.fn(async () => {});
    await runCategoryB({ ...baseDeps, warmAgentProcess });
    expect(warmAgentProcess).toHaveBeenCalledWith("claude-code");
  });

  it("points a sign-in rejection at Agents, never at restarting libi", async () => {
    resolveCli.mockResolvedValue(USABLE);
    const authErr = Object.assign(new Error("Authentication required"), { code: -32000 });
    const run = runCategoryB({ ...baseDeps, warmAgentProcess: async () => { throw authErr; } });
    await expect(run).rejects.toBeInstanceOf(BootPhaseError);
    await expect(run).rejects.toMatchObject({
      step: "agent-warm",
      hint: "Claude Code started but isn't signed in. Open Agents → Claude Code to sign in.",
    });
  });

  it("any other warm failure points at the agent's row in Agents, not at PATH", async () => {
    resolveCli.mockResolvedValue(USABLE);
    const run = runCategoryB({ ...baseDeps, warmAgentProcess: async () => { throw new Error("spawn ENOENT"); } });
    await expect(run).rejects.toMatchObject({
      step: "agent-warm",
      hint: "Failed to warm the agent subprocess. Open Agents and check the agent's row.",
    });
  });
});
