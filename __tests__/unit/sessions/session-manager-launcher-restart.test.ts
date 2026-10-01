/**
 * A launcher installed after Codex's process started (detection's `launcherAfterStart`): an IDLE process is restarted
 * once, with the PATH as it is now, so its MCP servers can run the launcher; a process a chat is using is kept
 * (PRV-2). The PATH bookkeeping is the real `lib/agents/agent-path.ts`; only the login-shell PATH is faked.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/libi-home", () => ({
  getLibiAgentDir: vi.fn(() => "/tmp/libi-test-agent"),
  getLibiHome: vi.fn(() => "/tmp/libi-test-home"),
  ensureLibiDirs: vi.fn(),
  getLibiLogDir: vi.fn(() => "/tmp/libi-test-logs"),
}));
vi.mock("@/lib/mcp-config", () => ({
  getMcpServersForAcp: vi.fn(() => []),
  onMcpConfigInvalidated: vi.fn(),
}));
vi.mock("@/lib/approval/settings", () => ({ getApprovalMode: vi.fn(() => "auto") }));
vi.mock("@/lib/sessions/model-preferences", () => ({
  getAgentModelId: vi.fn(() => null),
  setAgentModelId: vi.fn(),
}));
vi.mock("@/lib/agents/session-event-handler", () => ({
  SessionEventHandler: vi.fn().mockImplementation(() => ({
    createClient: vi.fn().mockReturnValue({}),
    cleanUserMessageParts: vi.fn(),
  })),
}));
vi.mock("@/lib/agents/sign-in-confirmation", () => ({ clearSignInConfirmation: vi.fn() }));
// The Codex lane's entry-shape diagnostic would spawn `codex mcp list`.
vi.mock("@/lib/agents/libi-registration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/libi-registration")>()),
  readLibiCodexEntryShape: vi.fn(async () => "absent"),
}));
// Standby freshness reads real config files; not what this is about.
vi.mock("@/lib/sessions/standby-freshness", () => ({
  captureStandbyFreshness: vi.fn(() => ({ config: "c", setupEpoch: 0, setupLive: false })),
  staleStandbyReason: vi.fn(() => null),
}));
const login = vi.hoisted(() => ({ dirs: null as string[] | null }));
vi.mock("@/lib/agents/cli/login-shell-path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/cli/login-shell-path")>()),
  lastLoginShellPathDirs: () => login.dirs,
}));

// Windows' fresh PATH: what the registry says now (`fresh`), readable only once a refresh has read it.
const registry = vi.hoisted(() => ({ fresh: null as string[] | null, read: null as string[] | null, refreshes: 0 }));
vi.mock("@/lib/agents/cli/windows-registry-path", () => ({
  lastWindowsRegistryPathDirs: () => registry.read,
  refreshWindowsRegistryPath: async () => {
    registry.refreshes++;
    registry.read = registry.fresh;
    return registry.read;
  },
}));

// Windows file lookups can't run on a posix host: the Windows case swaps the lookup for one that reads the folders
// it is handed (every other case uses the real one).
const lookup = vi.hoisted(() => ({ override: null as null | ((name: string, deps: { processPathDirs?: () => string[] }) => string) }));
vi.mock("@/lib/providers/launcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/launcher")>();
  return {
    ...actual,
    lookupLauncher: (name: string, deps: Parameters<typeof actual.lookupLauncher>[1]) =>
      lookup.override ? lookup.override(name, deps ?? {}) : actual.lookupLauncher(name, deps),
  };
});

import { SessionManager } from "@/lib/sessions/session-manager";
import { serverLogger } from "@/lib/logger";
import { __resetAgentSpawnPaths, agentChildPath, recordAgentSpawnPath } from "@/lib/agents/agent-path";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function createPm() {
  let n = 0;
  const conn = {
    listSessions: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
    newSession: vi.fn(async () => ({ sessionId: `s-${++n}` })),
    loadSession: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
    setSessionMode: vi.fn().mockResolvedValue(undefined),
  };
  let pending: Promise<void> | null = null;
  const pm = {
    getConnection: vi.fn(() => conn),
    warmProcess: vi.fn().mockResolvedValue(undefined),
    getCapabilitiesForAgent: vi.fn().mockReturnValue({ canListSessions: false }),
    registerSessionId: vi.fn(),
    unregisterSessionId: vi.fn(),
    spawnedWithShellEnv: vi.fn(() => true),
    // As the real one: the new process is spawned with the PATH as it is now, and recorded.
    restartProcess: vi.fn((agentId: string) => {
      const restart = (async () => {
        await Promise.resolve();
        recordAgentSpawnPath(agentId, agentChildPath());
      })().finally(() => {
        pending = null;
      });
      pending = restart.then(() => {}, () => {});
      return restart;
    }),
    pendingRestart: vi.fn(() => pending),
  };
  return { pm, conn };
}

describe("SessionManager — a launcher installed after Codex's process started", () => {
  let mocks: ReturnType<typeof createPm>;
  let sm: SessionManager;
  let tmp: string;
  let localBin: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    __resetAgentSpawnPaths();
    vi.stubEnv("PATH", "/usr/bin:/bin");
    login.dirs = null;
    mocks = createPm();
    sm = new SessionManager();
    sm.setProcessManager(mocks.pm as unknown as Parameters<SessionManager["setProcessManager"]>[0]);
    await sm.switchAgent("codex", { awaitStandbyMs: 2000 });
    // A real `uvx`, installed into a ~/.local/bin the running process was started without …
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-launcher-restart-"));
    localBin = path.join(tmp, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(path.join(localBin, "uvx"), "#!/bin/sh\n", { mode: 0o755 });
    recordAgentSpawnPath("codex", "/usr/bin:/bin", ":");
    // … which the login shell's PATH now has.
    login.dirs = [localBin, "/usr/bin"];
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetAgentSpawnPaths();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("an idle process is replaced once: its standby discarded, the process restarted with the new PATH, a standby made again", async () => {
    expect(sm.isStandbyReady()).toBe(true);
    const first = await sm.restartIdleAgentForLauncher("codex", ["uvx"]);
    expect(first).toHaveProperty("restarting");
    // A detection poll while it is under way joins it.
    expect(await sm.restartIdleAgentForLauncher("codex", ["uvx"])).toHaveProperty("restarting");
    await (first as { restarting: Promise<void> }).restarting;

    expect(mocks.pm.restartProcess).toHaveBeenCalledTimes(1);
    expect(mocks.pm.restartProcess).toHaveBeenCalledWith("codex");
    expect(mocks.conn.closeSession).toHaveBeenCalledWith({ sessionId: "s-1" });
    expect(mocks.pm.unregisterSessionId).toHaveBeenCalledWith("codex", "s-1");
    expect(sm.isStandbyReady()).toBe(true);

    // The new process has the launcher's folder, so detection stops flagging the row and nothing asks again.
    expect(fs.existsSync(path.join(localBin, "uvx"))).toBe(true);
    expect(mocks.pm.restartProcess).toHaveBeenCalledTimes(1);
  });

  it("a process a chat is using is never restarted, and says so once", async () => {
    const info = vi.spyOn(serverLogger, "info");
    await sm.createSession(); // claims the standby: a chat now runs on this process
    expect(await sm.restartIdleAgentForLauncher("codex", ["uvx"])).toEqual({ kept: "active_sessions" });
    expect(await sm.restartIdleAgentForLauncher("codex", ["uvx"])).toEqual({ kept: "active_sessions" });
    expect(mocks.pm.restartProcess).not.toHaveBeenCalled();
    expect(mocks.conn.closeSession).not.toHaveBeenCalled();
    expect(info.mock.calls.filter(([o]) => (o as { op?: string }).op === "launcher_restart_kept")).toHaveLength(1);
  });

  it("is not restarted when a new process would get no folder the running one lacks", async () => {
    login.dirs = ["/usr/bin"];
    expect(await sm.restartIdleAgentForLauncher("codex", ["uvx"])).toEqual({ kept: "launcher_not_reached" });
    expect(mocks.pm.restartProcess).not.toHaveBeenCalled();
  });

  // Review M2: under fnm every login-shell probe adds a new per-shell folder, so "any new folder" was almost always
  // true. The restart needs the flagged launcher itself to be on the new PATH.
  it("a new folder that doesn't hold the launcher is no reason to restart", async () => {
    const shim = path.join(tmp, "fnm_multishells", "123_456", "bin");
    fs.mkdirSync(shim, { recursive: true });
    login.dirs = [shim, "/usr/bin"];
    expect(await sm.restartIdleAgentForLauncher("codex", ["uvx"])).toEqual({ kept: "launcher_not_reached" });
    expect(await sm.restartIdleAgentForLauncher("codex", [])).toEqual({ kept: "launcher_not_reached" });
    expect(mocks.pm.restartProcess).not.toHaveBeenCalled();
  });
});

// Review I3: on Windows the comparison must use the registry's PATH as it is NOW. The last read may predate the install
// (it is taken at a spawn or a session/new), which would keep the process for good.
describe("SessionManager — the launcher restart on Windows reads the registry afresh", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  let tmp: string;
  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    vi.unstubAllEnvs();
    __resetAgentSpawnPaths();
    registry.fresh = registry.read = null;
    lookup.override = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("a launcher installed after the last registry read still restarts the idle process", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-launcher-restart-win-"));
    const localBin = path.join(tmp, "bin");
    fs.mkdirSync(localBin);
    vi.stubEnv("PATH", "C:\\Windows");
    lookup.override = (name, deps) => (name === "uvx" && (deps.processPathDirs?.() ?? []).includes(localBin) ? "found" : "missing");
    const mocks = createPm();
    const sm = new SessionManager();
    sm.setProcessManager(mocks.pm as unknown as Parameters<SessionManager["setProcessManager"]>[0]);
    await sm.switchAgent("codex", { awaitStandbyMs: 2000 });
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    registry.read = ["C:\\Windows"]; // the stale read, from before the install
    registry.fresh = ["C:\\Windows", localBin];
    const before = registry.refreshes;
    const answer = await sm.restartIdleAgentForLauncher("codex", ["uvx"]);
    expect(registry.refreshes).toBeGreaterThan(before);
    expect(answer).toHaveProperty("restarting");
    await (answer as { restarting: Promise<void> }).restarting;
    expect(mocks.pm.restartProcess).toHaveBeenCalledWith("codex");
  });
});
