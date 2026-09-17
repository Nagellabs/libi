/**
 * A session remembers whether its agent process was spawned with the user's shell environment,
 * and a standby spawned before the environment loaded is replaced once it does.
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

import { SessionManager } from "@/lib/sessions/session-manager";
import { serverLogger } from "@/lib/logger";
import { AgentSpawnRefusedError } from "@/lib/agents/spawn-refused-error";
import type { AgentMessage } from "@/lib/agents/message-types";
import { ACP_INIT_TIMEOUT_MS } from "@/lib/agents/managed-types";

// claude-code, not codex: the codex lane fires `logCodexEntryShape`, which spawns `codex mcp list`.

function createMockPm(opts: { canListSessions?: boolean } = {}) {
  let spawnedLoaded = false;
  const mockConnection = {
    listSessions: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
    newSession: vi.fn().mockResolvedValue({ sessionId: "s-standby" }),
    loadSession: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
    setSessionMode: vi.fn().mockResolvedValue(undefined),
  };
  const pm = {
    getConnection: vi.fn().mockReturnValue(mockConnection),
    warmProcess: vi.fn().mockResolvedValue(undefined),
    getCapabilitiesForAgent: vi.fn().mockReturnValue({ canListSessions: opts.canListSessions ?? false }),
    registerSessionId: vi.fn(),
    unregisterSessionId: vi.fn(),
    spawnedWithShellEnv: vi.fn(() => spawnedLoaded),
    // A restart spawns with whatever the seam says NOW.
    restartProcess: vi.fn(async (_agentId: string) => {
      spawnedLoaded = process.env.LIBI_SHELL_ENV === "loaded";
    }),
    /** No restart in flight unless a test says otherwise. */
    pendingRestart: vi.fn((): Promise<void> | null => null),
  };
  return { pm, mockConnection, setSpawnedLoaded: (v: boolean) => { spawnedLoaded = v; } };
}

/**
 * A process manager whose restart has the real no-connection window: the old connection is gone
 * the moment the restart begins, and the new process arrives only when the test says so.
 */
function createRestartingPm(opts: { canListSessions?: boolean } = {}) {
  const base = createMockPm(opts);
  let n = 0;
  const newConnection = {
    listSessions: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
    newSession: vi.fn(async () => ({ sessionId: `s-new-${++n}` })),
    loadSession: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
    setSessionMode: vi.fn().mockResolvedValue(undefined),
  };
  let current: object | null = base.mockConnection;
  let pending: Promise<void> | null = null;
  let settle: { up: () => void; fail: (err: Error) => void } | null = null;
  /** The new process is up: its connection replaces the old one, spawned with the environment. */
  const comeUp = () => {
    current = newConnection;
    base.setSpawnedLoaded(true);
  };
  base.pm.getConnection.mockImplementation(() => current);
  base.pm.restartProcess.mockImplementation(() => {
    current = null;
    // As in the real process manager, the restart is no longer pending by the time its caller sees
    // it settle.
    const restart = new Promise<void>((resolve, reject) => {
      settle = { up: () => { comeUp(); resolve(); }, fail: reject };
    }).finally(() => { pending = null; });
    pending = restart.then(() => {}, () => {});
    return restart;
  });
  base.pm.pendingRestart.mockImplementation(() => pending);
  return {
    ...base,
    newConnection,
    comeUp,
    restart: { up: () => settle!.up(), fail: (err: Error) => settle!.fail(err) },
  };
}

describe("SessionManager — the shell environment", () => {
  let envSnapshot: NodeJS.ProcessEnv;
  let mocks: ReturnType<typeof createMockPm>;
  let sm: SessionManager;

  function build(opts: { canListSessions?: boolean } = {}) {
    mocks = createMockPm(opts);
    sm = new SessionManager();
    sm.setProcessManager(mocks.pm);
  }

  function buildRestarting(opts: { canListSessions?: boolean } = {}) {
    const restarting = createRestartingPm(opts);
    mocks = restarting;
    sm = new SessionManager();
    sm.setProcessManager(restarting.pm);
    return restarting;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    envSnapshot = { ...process.env };
    process.env.LIBI_SHELL_ENV = "pending";
    build();
  });
  afterEach(() => {
    vi.useRealTimers();
    process.env = envSnapshot;
  });

  it("a chat claimed from a standby keeps the standby's spawn-time answer; a fresh chat asks the process", async () => {
    mocks.mockConnection.newSession
      .mockResolvedValueOnce({ sessionId: "s-standby" }) // the standby switchAgent creates
      .mockReturnValueOnce(new Promise(() => {})) // the replenish after the claim — never lands
      .mockResolvedValueOnce({ sessionId: "s-fresh" }); // so the next chat is created fresh
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });

    const claimed = await sm.createSession();
    expect(claimed).toBe("s-standby");
    expect(sm.getSession(claimed)?.shellEnvLoaded).toBe(false);

    mocks.setSpawnedLoaded(true);
    const fresh = await sm.createSession();
    expect(fresh).toBe("s-fresh");
    expect(sm.getSession(fresh)?.shellEnvLoaded).toBe(true);
  });

  it("a resumed session takes the answer of the process it is activated on", async () => {
    build({ canListSessions: true });
    mocks.mockConnection.listSessions.mockResolvedValueOnce({
      sessions: [{ sessionId: "old-1", title: "Old", updatedAt: null }],
      nextCursor: null,
    });
    await sm.loadInitialSessions("claude-code");
    expect(sm.getSession("old-1")?.shellEnvLoaded).toBeUndefined();
    await sm.activateSession("old-1");
    expect(sm.getSession("old-1")?.shellEnvLoaded).toBe(false);
  });

  it("once the environment loads, an idle agent's standby is discarded, the agent restarted, and the next chat starts with it", async () => {
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    expect(sm.isStandbyReady()).toBe(true);
    const events: unknown[] = [];
    sm.onSystemEvent((e) => events.push(e));
    mocks.mockConnection.newSession.mockResolvedValueOnce({ sessionId: "s-after" });

    process.env.LIBI_SHELL_ENV = "loaded";
    await sm.refreshStandbyForShellEnv();

    expect(mocks.mockConnection.closeSession).toHaveBeenCalledWith({ sessionId: "s-standby" });
    expect(mocks.pm.unregisterSessionId).toHaveBeenCalledWith("claude-code", "s-standby");
    expect(mocks.pm.restartProcess).toHaveBeenCalledWith("claude-code");
    expect(events).toContainEqual({ type: "standby-ready", ready: false });
    expect(sm.isStandbyReady()).toBe(true);
    const next = await sm.createSession();
    expect(next).toBe("s-after");
    expect(sm.getSession(next)?.shellEnvLoaded).toBe(true);
  });

  it("does nothing while the environment is still pending, or after it failed", async () => {
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    await sm.refreshStandbyForShellEnv();
    process.env.LIBI_SHELL_ENV = "failed";
    await sm.refreshStandbyForShellEnv();
    expect(mocks.pm.restartProcess).not.toHaveBeenCalled();
    expect(mocks.mockConnection.closeSession).not.toHaveBeenCalled();
    expect(sm.isStandbyReady()).toBe(true);
  });

  it("a chat running on the agent's process is never killed: no restart, the standby kept, and that chat keeps its warning", async () => {
    mocks.mockConnection.newSession
      .mockResolvedValueOnce({ sessionId: "s-standby" })
      .mockResolvedValueOnce({ sessionId: "s-standby-2" });
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    const running = await sm.createSession(); // claims s-standby: a live chat now runs on this process
    expect(sm.getSession(running)?.shellEnvLoaded).toBe(false);
    await vi.waitFor(() => expect(sm.isStandbyReady()).toBe(true)); // the replenished standby
    process.env.LIBI_SHELL_ENV = "loaded";
    await sm.refreshStandbyForShellEnv();
    expect(mocks.pm.restartProcess).not.toHaveBeenCalled();
    expect(mocks.mockConnection.closeSession).not.toHaveBeenCalled();
    expect(sm.isStandbyReady()).toBe(true);
    expect(sm.getSession(running)?.shellEnvLoaded).toBe(false); // the running chat keeps its warning
  });

  it("a standby that finishes creating AFTER the environment loaded is refreshed at once", async () => {
    let land!: (v: { sessionId: string }) => void;
    mocks.mockConnection.newSession
      .mockReturnValueOnce(new Promise((r) => { land = r; }))
      .mockResolvedValueOnce({ sessionId: "s-after" });
    await sm.switchAgent("claude-code"); // standby creation in flight on a not-loaded process
    process.env.LIBI_SHELL_ENV = "loaded";
    land({ sessionId: "s-early" });
    await vi.waitFor(() => expect(mocks.pm.restartProcess).toHaveBeenCalledWith("claude-code"));
    await vi.waitFor(() => expect(sm.isStandbyReady()).toBe(true));
    expect(mocks.mockConnection.closeSession).toHaveBeenCalledWith({ sessionId: "s-early" });
  });

  it("the watcher polls the seam and refreshes once, when the state turns `loaded`", async () => {
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    vi.useFakeTimers();
    sm.watchShellEnvState(1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(mocks.pm.restartProcess).not.toHaveBeenCalled();
    process.env.LIBI_SHELL_ENV = "loaded";
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.pm.restartProcess).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.pm.restartProcess).toHaveBeenCalledTimes(1); // it stopped polling
  });

  it("the watcher never starts without the variable (npx, dev, Windows), and stops on `failed`", async () => {
    vi.useFakeTimers();
    delete process.env.LIBI_SHELL_ENV;
    sm.watchShellEnvState(1000);
    expect(vi.getTimerCount()).toBe(0);
    process.env.LIBI_SHELL_ENV = "pending";
    sm.watchShellEnvState(1000);
    expect(vi.getTimerCount()).toBe(1);
    process.env.LIBI_SHELL_ENV = "failed";
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.pm.restartProcess).not.toHaveBeenCalled();
  });

  it("a chat being opened is never killed: a resume still loading when the environment loads keeps the process and the standby", async () => {
    build({ canListSessions: true });
    mocks.mockConnection.listSessions.mockResolvedValueOnce({
      sessions: [{ sessionId: "old-1", title: "Old", updatedAt: null }],
      nextCursor: null,
    });
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    let finishLoad!: () => void;
    mocks.mockConnection.loadSession.mockReturnValueOnce(new Promise<void>((r) => { finishLoad = r; }));
    const resume = sm.activateSession("old-1");
    await vi.waitFor(() => expect(mocks.mockConnection.loadSession).toHaveBeenCalled());

    process.env.LIBI_SHELL_ENV = "loaded";
    await sm.refreshStandbyForShellEnv();
    expect(mocks.pm.restartProcess).not.toHaveBeenCalled();
    expect(mocks.mockConnection.closeSession).not.toHaveBeenCalled();
    expect(sm.isStandbyReady()).toBe(true);

    finishLoad();
    await expect(resume).resolves.toEqual([]);
    expect(sm.hasActiveSession("old-1")).toBe(true);
  });

  it("a chat being created is never killed: a fresh session still being set up keeps the process and the standby", async () => {
    let landReplenish!: (v: { sessionId: string }) => void;
    let landFresh!: (v: { sessionId: string }) => void;
    mocks.mockConnection.newSession
      .mockResolvedValueOnce({ sessionId: "s-standby" })
      .mockReturnValueOnce(new Promise((r) => { landReplenish = r; }))
      .mockReturnValueOnce(new Promise((r) => { landFresh = r; }));
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    const claimed = await sm.createSession(); // its standby replenish is now in flight
    await sm.deactivateSession(claimed); // nothing is running on the process any more
    const creating = sm.createSession(); // no standby yet, so this one is created fresh
    await vi.waitFor(() => expect(mocks.mockConnection.newSession).toHaveBeenCalledTimes(3));
    landReplenish({ sessionId: "s-replenished" });
    await vi.waitFor(() => expect(sm.isStandbyReady()).toBe(true));

    process.env.LIBI_SHELL_ENV = "loaded";
    await sm.refreshStandbyForShellEnv();
    expect(mocks.pm.restartProcess).not.toHaveBeenCalled();
    expect(sm.isStandbyReady()).toBe(true);

    landFresh({ sessionId: "s-fresh" });
    await expect(creating).resolves.toBe("s-fresh");
  });

  it("a resume that starts while the agent restarts waits for the new process, then loads its history there", async () => {
    const r = buildRestarting({ canListSessions: true });
    r.mockConnection.listSessions.mockResolvedValueOnce({
      sessions: [{ sessionId: "old-1", title: "Old", updatedAt: null }],
      nextCursor: null,
    });
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    process.env.LIBI_SHELL_ENV = "loaded";
    const refresh = sm.refreshStandbyForShellEnv();
    expect(r.pm.restartProcess).toHaveBeenCalledWith("claude-code");

    const history = { id: "m1", role: "user", parts: [], timestamp: 1 } as AgentMessage;
    r.newConnection.loadSession.mockImplementationOnce(async () => {
      sm.getSession("old-1")!.messageCache.push(history);
    });
    const resume = sm.activateSession("old-1"); // no connection at this moment
    r.restart.up();

    await expect(resume).resolves.toEqual([history]);
    expect(r.newConnection.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "old-1" }));
    expect(r.mockConnection.loadSession).not.toHaveBeenCalled();
    expect(sm.getSession("old-1")?.shellEnvLoaded).toBe(true);
    await refresh;
    expect(sm.isStandbyReady()).toBe(true);
  });

  it("a new chat started while the agent restarts waits for the new process instead of failing", async () => {
    const r = buildRestarting();
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    process.env.LIBI_SHELL_ENV = "loaded";
    const refresh = sm.refreshStandbyForShellEnv();
    expect(sm.isStandbyReady()).toBe(false);

    const creating = sm.createSession(); // no standby and no connection at this moment
    r.restart.up();

    const id = await creating;
    expect(id).toMatch(/^s-new-/);
    expect(r.newConnection.newSession).toHaveBeenCalled();
    expect(sm.getSession(id)?.shellEnvLoaded).toBe(true);
    await refresh;
    await vi.waitFor(() => expect(sm.isStandbyReady()).toBe(true));
  });

  /** Lets every queued background step (a re-warm, a standby creation) run. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
  const initTimeout = () => new Error("ACP initialize timed out for claude-code");

  /**
   * The restart fails for a reason other than a refusal, and so does the one background start that
   * follows it. Returns once that start has been given up on, having asserted it happened exactly
   * once — so a test can go on to exercise what the USER does next.
   */
  async function failRestartAndItsRewarm(r: ReturnType<typeof createRestartingPm>) {
    const warn = vi.spyOn(serverLogger, "warn");
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    r.pm.warmProcess.mockRejectedValueOnce(initTimeout()); // the background start fails too
    process.env.LIBI_SHELL_ENV = "loaded";
    const refresh = sm.refreshStandbyForShellEnv();
    r.restart.fail(initTimeout());
    await refresh;
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ tag: "session-manager", op: "shell_env_restart_rewarm_failed", agentId: "claude-code" }),
        expect.any(String),
      ),
    );
    await settle();
    expect(r.pm.warmProcess.mock.calls).toEqual([["claude-code"], ["claude-code"]]); // the switch, then ONE re-warm — no loop
    warn.mockRestore();
    expect(r.pm.getConnection("claude-code")).toBeNull();
    expect(sm.isStandbyReady()).toBe(false);
  }

  it("a restart that fails for another reason is logged, leaves readiness alone, and starts the agent again once in the background, bringing New chat back", async () => {
    const r = buildRestarting();
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    const readinessBefore = sm.getReadiness("claude-code");
    const events: unknown[] = [];
    sm.onSystemEvent((e) => events.push(e));
    const warn = vi.spyOn(serverLogger, "warn");
    r.pm.warmProcess.mockImplementationOnce(async () => r.comeUp()); // the background start succeeds
    process.env.LIBI_SHELL_ENV = "loaded";
    const refresh = sm.refreshStandbyForShellEnv();
    r.restart.fail(initTimeout());
    await refresh;

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "session-manager", op: "shell_env_standby_refresh_failed", agentId: "claude-code" }),
      expect.any(String),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "session-manager", op: "shell_env_restart_rewarm", agentId: "claude-code" }),
      expect.any(String),
    );
    warn.mockRestore();
    expect(sm.getReadiness("claude-code")).toEqual(readinessBefore);

    // Nobody opened a chat or picked the agent: the standby comes back on its own.
    await vi.waitFor(() => expect(sm.isStandbyReady()).toBe(true));
    expect(events).toContainEqual({ type: "standby-ready", ready: true });
    expect(r.pm.warmProcess.mock.calls).toEqual([["claude-code"], ["claude-code"]]); // the switch, then ONE re-warm
    expect(r.newConnection.newSession).toHaveBeenCalledTimes(1);
    await settle();
    expect(r.pm.warmProcess).toHaveBeenCalledTimes(2); // nothing loops

    // The next chat claims that standby, and it runs with the environment.
    const id = await sm.createSession();
    expect(id).toBe("s-new-1");
    expect(sm.getSession(id)?.shellEnvLoaded).toBe(true);
    expect(r.pm.warmProcess).toHaveBeenCalledTimes(2);
  });

  it("a restart REFUSED for a missing or outdated CLI records not-installed and does not start the agent again", async () => {
    const r = buildRestarting();
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    const warn = vi.spyOn(serverLogger, "warn");
    process.env.LIBI_SHELL_ENV = "loaded";
    const refresh = sm.refreshStandbyForShellEnv();
    r.restart.fail(new AgentSpawnRefusedError("claude-code", {
      code: "not_installed",
      message: "Claude Code 2.0.1 is older than libi needs — open Agents to update it.",
      detail: "below minimum",
    }));
    await refresh;
    await settle();

    expect(sm.getReadiness("claude-code")).toEqual({
      state: "not-installed",
      reason: "Claude Code 2.0.1 is older than libi needs — open Agents to update it.",
    });
    expect(r.pm.warmProcess).toHaveBeenCalledTimes(1); // the switch only
    expect(warn).not.toHaveBeenCalledWith(expect.objectContaining({ op: "shell_env_restart_rewarm" }), expect.anything());
    warn.mockRestore();
    expect(r.pm.getConnection("claude-code")).toBeNull();
    expect(sm.isStandbyReady()).toBe(false);
  });

  it("the background start stands down when another agent is picked while it is starting", async () => {
    const r = buildRestarting();
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    let finishWarm!: () => void;
    r.pm.warmProcess.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishWarm = () => { r.comeUp(); resolve(); };
    }));
    process.env.LIBI_SHELL_ENV = "loaded";
    const refresh = sm.refreshStandbyForShellEnv();
    r.restart.fail(initTimeout());
    await refresh;
    expect(r.pm.warmProcess).toHaveBeenCalledTimes(2);

    await sm.switchAgent("other-agent"); // no connection for it yet, so it sets no standby up
    finishWarm();
    await settle();
    expect(r.newConnection.newSession).not.toHaveBeenCalled(); // no standby created for whichever agent is active
    expect(sm.isStandbyReady()).toBe(false);
  });

  it("the background start stands down when another restart has begun meanwhile", async () => {
    const r = buildRestarting();
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    let finishWarm!: () => void;
    r.pm.warmProcess.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishWarm = () => { r.comeUp(); resolve(); };
    }));
    process.env.LIBI_SHELL_ENV = "loaded";
    const refresh = sm.refreshStandbyForShellEnv();
    r.restart.fail(initTimeout());
    await refresh;

    void r.pm.restartProcess("claude-code"); // a newer restart, still under way
    finishWarm();
    await settle();
    expect(r.newConnection.newSession).not.toHaveBeenCalled(); // that restart's owner sets the standby up
    expect(sm.isStandbyReady()).toBe(false);
  });

  it("a resume that joins the background start loads its history before the standby's session/new is sent, and the standby still comes back", async () => {
    const r = buildRestarting({ canListSessions: true });
    r.mockConnection.listSessions.mockResolvedValueOnce({
      sessions: [{ sessionId: "old-1", title: "Old", updatedAt: null }],
      nextCursor: null,
    });
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    let finishSpawn!: () => void;
    const spawn = new Promise<void>((resolve) => {
      finishSpawn = () => { r.comeUp(); resolve(); };
    });
    // Every start from here on joins the one spawn, as the real process manager does.
    r.pm.warmProcess.mockImplementation(() => spawn);
    process.env.LIBI_SHELL_ENV = "loaded";
    const refresh = sm.refreshStandbyForShellEnv();
    r.restart.fail(initTimeout());
    await refresh;
    expect(r.pm.warmProcess).toHaveBeenCalledTimes(2); // the switch, then the background start

    let finishLoad!: () => void;
    r.newConnection.loadSession.mockReturnValueOnce(new Promise<void>((resolve) => { finishLoad = resolve; }));
    const resume = sm.activateSession("old-1"); // no connection yet, so it joins the spawn
    await vi.waitFor(() => expect(r.pm.warmProcess).toHaveBeenCalledTimes(3));
    finishSpawn();
    await vi.waitFor(() => expect(r.newConnection.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "old-1" })));
    await settle();
    expect(r.newConnection.newSession).not.toHaveBeenCalled(); // nothing competes with the replay
    expect(sm.isStandbyReady()).toBe(false);

    finishLoad();
    await expect(resume).resolves.toEqual([]);
    await vi.waitFor(() => expect(sm.isStandbyReady()).toBe(true)); // "New chat" comes back
    expect(r.newConnection.newSession).toHaveBeenCalledTimes(1);
    expect(r.newConnection.loadSession.mock.invocationCallOrder[0]).toBeLessThan(
      r.newConnection.newSession.mock.invocationCallOrder[0],
    );
  });

  it("the background start waits for a resume that fails, then still brings the standby back", async () => {
    const r = buildRestarting({ canListSessions: true });
    r.mockConnection.listSessions.mockResolvedValueOnce({
      sessions: [{ sessionId: "old-1", title: "Old", updatedAt: null }],
      nextCursor: null,
    });
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    let finishSpawn!: () => void;
    const spawn = new Promise<void>((resolve) => {
      finishSpawn = () => { r.comeUp(); resolve(); };
    });
    r.pm.warmProcess.mockImplementation(() => spawn);
    process.env.LIBI_SHELL_ENV = "loaded";
    const refresh = sm.refreshStandbyForShellEnv();
    r.restart.fail(initTimeout());
    await refresh;

    let failLoad!: (err: Error) => void;
    r.newConnection.loadSession.mockReturnValueOnce(new Promise<void>((_, reject) => { failLoad = reject; }));
    const resume = sm.activateSession("old-1");
    await vi.waitFor(() => expect(r.pm.warmProcess).toHaveBeenCalledTimes(3));
    finishSpawn();
    await vi.waitFor(() => expect(r.newConnection.loadSession).toHaveBeenCalled());
    await settle();
    expect(r.newConnection.newSession).not.toHaveBeenCalled();

    failLoad(new Error("history unavailable"));
    await expect(resume).rejects.toThrow("history unavailable");
    await vi.waitFor(() => expect(sm.isStandbyReady()).toBe(true));
    expect(r.newConnection.newSession).toHaveBeenCalledTimes(1);
  });

  it("a resume that never finishes loading holds the background start's standby back only until the cap, then the standby still comes back", async () => {
    const r = buildRestarting({ canListSessions: true });
    r.mockConnection.listSessions.mockResolvedValueOnce({
      sessions: [{ sessionId: "old-1", title: "Old", updatedAt: null }],
      nextCursor: null,
    });
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    let finishSpawn!: () => void;
    const spawn = new Promise<void>((resolve) => {
      finishSpawn = () => { r.comeUp(); resolve(); };
    });
    r.pm.warmProcess.mockImplementation(() => spawn);
    process.env.LIBI_SHELL_ENV = "loaded";
    const refresh = sm.refreshStandbyForShellEnv();
    r.restart.fail(initTimeout());
    await refresh;

    const warn = vi.spyOn(serverLogger, "warn");
    r.newConnection.loadSession.mockReturnValueOnce(new Promise<void>(() => {})); // a live adapter that never answers
    void sm.activateSession("old-1");
    await vi.waitFor(() => expect(r.pm.warmProcess).toHaveBeenCalledTimes(3));
    vi.useFakeTimers();
    finishSpawn();
    await vi.waitFor(() => expect(r.newConnection.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "old-1" })));

    await vi.advanceTimersByTimeAsync(ACP_INIT_TIMEOUT_MS - 1_000);
    expect(r.newConnection.newSession).not.toHaveBeenCalled(); // still waiting on the load
    expect(sm.isStandbyReady()).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(sm.isStandbyReady()).toBe(true)); // "New chat" comes back regardless
    expect(r.newConnection.newSession).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "session-manager", op: "shell_env_restart_rewarm_resume_wait_capped", agentId: "claude-code" }),
      expect.any(String),
    );
    warn.mockRestore();
  });

  it("resumes that begin after the background start began waiting do not extend its wait", async () => {
    const r = buildRestarting({ canListSessions: true });
    r.mockConnection.listSessions.mockResolvedValueOnce({
      sessions: [
        { sessionId: "old-1", title: "Old", updatedAt: null },
        { sessionId: "old-2", title: "Older", updatedAt: null },
      ],
      nextCursor: null,
    });
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    let finishWarm!: () => void;
    r.pm.warmProcess.mockImplementationOnce(() => new Promise<void>((resolve) => { finishWarm = resolve; }));
    process.env.LIBI_SHELL_ENV = "loaded";
    const refresh = sm.refreshStandbyForShellEnv();
    r.restart.fail(initTimeout());
    await refresh;
    expect(r.pm.warmProcess).toHaveBeenCalledTimes(2); // the switch, then the background start

    const loads = new Map<string, () => void>();
    r.newConnection.loadSession.mockImplementation(
      ({ sessionId }: { sessionId: string }) => new Promise<void>((resolve) => loads.set(sessionId, resolve)),
    );
    // The new process is up and a resume reaches it before the background start sees its own start
    // land, so that resume is under way when the wait begins, and it does not bring the standby
    // back itself: it did not start the process.
    r.comeUp();
    const first = sm.activateSession("old-1");
    await vi.waitFor(() => expect(loads.has("old-1")).toBe(true));
    finishWarm();
    await settle();

    // The user opens another past chat while the wait is still open.
    const second = sm.activateSession("old-2");
    await vi.waitFor(() => expect(loads.has("old-2")).toBe(true));
    expect(r.newConnection.newSession).not.toHaveBeenCalled();

    loads.get("old-1")!();
    await expect(first).resolves.toEqual([]);
    await vi.waitFor(() => expect(sm.isStandbyReady()).toBe(true)); // not held back by old-2
    expect(r.newConnection.newSession).toHaveBeenCalledTimes(1);
    expect(r.pm.warmProcess).toHaveBeenCalledTimes(2); // neither resume started the process

    loads.get("old-2")!();
    await expect(second).resolves.toEqual([]);
    await settle();
    expect(r.newConnection.newSession).toHaveBeenCalledTimes(1);
  });

  it("the background start stands down when the agent is picked again while it waits on a resume, and the pick's standby is the one that comes up", async () => {
    const r = buildRestarting({ canListSessions: true });
    r.mockConnection.listSessions.mockResolvedValueOnce({
      sessions: [{ sessionId: "old-1", title: "Old", updatedAt: null }],
      nextCursor: null,
    });
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    let finishSpawn!: () => void;
    const spawn = new Promise<void>((resolve) => {
      finishSpawn = () => { r.comeUp(); resolve(); };
    });
    r.pm.warmProcess.mockImplementation(() => spawn);
    process.env.LIBI_SHELL_ENV = "loaded";
    const refresh = sm.refreshStandbyForShellEnv();
    r.restart.fail(initTimeout());
    await refresh;

    let finishLoad!: () => void;
    r.newConnection.loadSession.mockReturnValueOnce(new Promise<void>((resolve) => { finishLoad = resolve; }));
    const resume = sm.activateSession("old-1");
    await vi.waitFor(() => expect(r.pm.warmProcess).toHaveBeenCalledTimes(3));
    finishSpawn();
    await vi.waitFor(() => expect(r.newConnection.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "old-1" })));
    await settle();
    expect(r.newConnection.newSession).not.toHaveBeenCalled(); // the background start is waiting

    const info = vi.spyOn(serverLogger, "info");
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 }); // the pick sets its own standby up
    expect(sm.isStandbyReady()).toBe(true);
    expect(r.newConnection.newSession).toHaveBeenCalledTimes(1);

    finishLoad();
    await Promise.allSettled([resume]);
    await settle();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "session-manager", op: "shell_env_restart_rewarm_superseded", agentId: "claude-code" }),
      expect.any(String),
    );
    info.mockRestore();
    expect(r.newConnection.newSession).toHaveBeenCalledTimes(1); // no second standby
    expect(await sm.createSession()).toBe("s-new-1"); // the chat claims the pick's standby
  });

  it("no background start when the agent was picked again while the restart ran", async () => {
    const r = buildRestarting();
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    process.env.LIBI_SHELL_ENV = "loaded";
    const refresh = sm.refreshStandbyForShellEnv();
    await sm.switchAgent("claude-code"); // the pick starts the agent itself
    expect(r.pm.warmProcess).toHaveBeenCalledTimes(2);
    r.restart.fail(initTimeout());
    await refresh;
    await settle();
    expect(r.pm.warmProcess).toHaveBeenCalledTimes(2);
  });

  it("when the background start after a failed restart fails too, a resume warms the agent, loads its history on the new process, and brings the standby back", async () => {
    const r = buildRestarting({ canListSessions: true });
    r.mockConnection.listSessions.mockResolvedValueOnce({
      sessions: [{ sessionId: "old-1", title: "Old", updatedAt: null }],
      nextCursor: null,
    });
    await failRestartAndItsRewarm(r);

    const history = { id: "m1", role: "user", parts: [], timestamp: 1 } as AgentMessage;
    r.newConnection.loadSession.mockImplementationOnce(async () => {
      sm.getSession("old-1")!.messageCache.push(history);
    });
    r.pm.warmProcess.mockImplementationOnce(async () => r.comeUp());
    await expect(sm.activateSession("old-1")).resolves.toEqual([history]);

    expect(r.pm.warmProcess).toHaveBeenCalledTimes(3); // the resume started it
    expect(r.newConnection.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "old-1" }));
    expect(sm.getSession("old-1")?.shellEnvLoaded).toBe(true);
    await vi.waitFor(() => expect(sm.isStandbyReady()).toBe(true)); // "New chat" comes back
  });

  it("when the background start after a failed restart fails too, picking the agent again warms it and brings the standby back", async () => {
    const r = buildRestarting();
    await failRestartAndItsRewarm(r);

    r.pm.warmProcess.mockImplementationOnce(async () => r.comeUp());
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    expect(r.pm.warmProcess).toHaveBeenCalledTimes(3); // the pick started it
    expect(sm.isStandbyReady()).toBe(true);
  });
});
