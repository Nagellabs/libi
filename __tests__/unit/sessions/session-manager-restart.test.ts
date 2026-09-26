import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AgentEvent } from "@/lib/agents/types";

/**
 * "Restart session" (the chat's right-click menu → POST /api/sessions/:id/restart →
 * `SessionManager.restartSession`). A restart keeps the conversation and makes the adapter build
 * the session again, so an MCP server the user added after the chat was created is in it
 * afterwards. Both adapters need the CLOSE before the load — verified live against
 * claude-agent-acp 0.75.1 and codex-acp 1.10.0 on 2026-09-25 (a loadSession without the close
 * never started a server added to the config after the session; close + load did, on the same
 * adapter process) — see docs-local/qa/2026-09-25-elevenlabs-taskC-report.md.
 */

vi.mock("@/lib/libi-home", () => ({
  getLibiAgentDir: vi.fn(() => "/tmp/libi-test-agent"),
  getLibiHome: vi.fn(() => "/tmp/libi-test-home"),
  ensureLibiDirs: vi.fn(),
  getLibiLogDir: vi.fn(() => "/tmp/libi-test-logs"),
}));
vi.mock("@/lib/agents/libi-registration", () => ({ readLibiCodexEntryShape: vi.fn(async () => "unknown") }));
vi.mock("@/lib/agents/sign-in-confirmation", () => ({ clearSignInConfirmation: vi.fn() }));

const LIBI_ENTRY = { type: "http", name: "libi", url: "http://127.0.0.1:3457/mcp?agent=claude", headers: [] };
const mcp = vi.hoisted(() => ({ servers: [] as unknown[] }));
vi.mock("@/lib/mcp-config", () => ({
  getMcpServersForAcp: vi.fn(() => mcp.servers),
  getMcpServersForAcpFallback: vi.fn(() => mcp.servers),
  onMcpConfigInvalidated: vi.fn(),
}));
vi.mock("@/lib/sessions/standby-freshness", () => ({
  captureStandbyFreshness: vi.fn(() => ({ config: "d", setupEpoch: 0, setupLive: false })),
  staleStandbyReason: vi.fn(() => null),
}));
vi.mock("@/lib/approval/settings", () => ({ getApprovalMode: vi.fn(() => "auto") }));
vi.mock("@/lib/sessions/model-preferences", () => ({ getAgentModelId: vi.fn(() => null), setAgentModelId: vi.fn() }));
vi.mock("@/lib/agents/session-event-handler", () => ({
  SessionEventHandler: vi.fn().mockImplementation(() => ({
    createClient: vi.fn().mockReturnValue({}),
    cleanUserMessageParts: vi.fn(),
  })),
}));
const analytics = vi.hoisted(() => ({ trackServerEvent: vi.fn() }));
vi.mock("@/lib/analytics/server", () => analytics);
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() }));
vi.mock("@/lib/logger", () => ({ serverLogger: log, mcpLogger: log }));

import {
  CANCEL_SETTLE_TIMEOUT_MS,
  RETIRED_TURN_GRACE_MS,
  RESTART_CLOSE_TIMEOUT_MS,
  RESTART_DEADLINE_MS,
  RESTART_LOAD_TIMEOUT_MS,
  RESTART_STALE_SETTLE_MS,
  SessionManager,
  SessionRestartError,
} from "@/lib/sessions/session-manager";
import { isSessionMidTurn } from "@/lib/sessions/types";

type Conn = {
  listSessions: ReturnType<typeof vi.fn>;
  newSession: ReturnType<typeof vi.fn>;
  loadSession: ReturnType<typeof vi.fn>;
  closeSession: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  setSessionMode: ReturnType<typeof vi.fn>;
  setSessionConfigOption: ReturnType<typeof vi.fn>;
};

function makeConn(): Conn {
  return {
    listSessions: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
    newSession: vi.fn().mockResolvedValue({ sessionId: "chat-1" }),
    loadSession: vi.fn().mockResolvedValue({}),
    closeSession: vi.fn().mockResolvedValue({}),
    prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
    cancel: vi.fn().mockResolvedValue(undefined),
    setSessionMode: vi.fn().mockResolvedValue(undefined),
    setSessionConfigOption: vi.fn().mockResolvedValue(undefined),
  };
}

function makePm(conn: { current: Conn }) {
  return {
    getConnection: vi.fn(() => conn.current),
    warmProcess: vi.fn().mockResolvedValue(undefined),
    getCapabilitiesForAgent: vi.fn().mockReturnValue({ canListSessions: true }),
    registerSessionId: vi.fn(),
    unregisterSessionId: vi.fn(),
    restartProcess: vi.fn(async () => {}),
    pendingRestart: vi.fn(() => null),
  };
}

let conn: { current: Conn };
let pm: ReturnType<typeof makePm>;
let sm: SessionManager;

async function openChat(agentId: "claude-code" | "codex", sessionId: string): Promise<string> {
  await sm.loadInitialSessions(agentId);
  conn.current.newSession.mockResolvedValueOnce({ sessionId, modes: { availableModes: [{ id: "default" }, { id: "agent" }] } });
  return sm.createSession();
}

/** What the SSE route forwards for `sessionId` — it listens globally (`onGlobalEvent`). */
function eventsOf(sessionId: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  sm.onGlobalEvent((id, e) => {
    if (id === sessionId) events.push(e);
  });
  return events;
}

const restartPhases = (events: AgentEvent[]) =>
  events.filter((e): e is Extract<AgentEvent, { type: "session-restart" }> => e.type === "session-restart").map((e) => e.phase);

beforeEach(() => {
  vi.clearAllMocks();
  mcp.servers = [LIBI_ENTRY];
  conn = { current: makeConn() };
  pm = makePm(conn);
  sm = new SessionManager();
  sm.setProcessManager(pm as unknown as Parameters<SessionManager["setProcessManager"]>[0]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each([["claude-code"], ["codex"]] as const)("restartSession (%s)", (agentId) => {
  it("closes the ACP session, then loads the SAME session with the mcpServers a fresh session gets", async () => {
    const id = await openChat(agentId, `${agentId}-chat`);
    const c = conn.current;
    c.closeSession.mockClear();
    c.loadSession.mockClear();
    c.newSession.mockClear();

    const result = await sm.restartSession(id);

    expect(result).toEqual({ agentId, processRestarted: false });
    expect(c.closeSession).toHaveBeenCalledWith({ sessionId: id });
    expect(c.loadSession).toHaveBeenCalledWith({ sessionId: id, cwd: "/tmp/libi-test-agent", mcpServers: [LIBI_ENTRY] });
    // close strictly before the load: a load on a session the adapter still holds returns early
    // (claude-agent-acp's fingerprint) or re-attaches without re-reading config (codex).
    expect(c.closeSession.mock.invocationCallOrder[0]).toBeLessThan(c.loadSession.mock.invocationCallOrder[0]);
    expect(c.newSession).not.toHaveBeenCalled(); // the same chat, never a replacement
    expect(sm.hasActiveSession(id)).toBe(true);
    expect(pm.restartProcess).not.toHaveBeenCalled();
  });

  it("keeps the conversation: history is the adapter's replay, the approval mode is pushed again", async () => {
    const id = await openChat(agentId, `${agentId}-hist`);
    conn.current.loadSession.mockImplementationOnce(async () => {
      sm.getSession(id)!.messageCache.push(
        { id: "u1", role: "user", parts: [{ type: "text", text: "make a video" }], timestamp: 1 },
        { id: "a1", role: "agent", parts: [{ type: "text", text: "on it" }], timestamp: 2 },
      );
      return {};
    });
    conn.current.setSessionMode.mockClear();

    await sm.restartSession(id);

    expect(sm.getMessageCache(id).map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(conn.current.setSessionMode).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id }));
  });

  it("tells the chat over SSE (started → done), logs it, and records the adoption event", async () => {
    const id = await openChat(agentId, `${agentId}-sse`);
    const events = eventsOf(id);

    await sm.restartSession(id);

    expect(restartPhases(events)).toEqual(["started", "done"]);
    const ops = log.info.mock.calls.map(([o]) => (o as { op?: string }).op);
    expect(ops).toContain("session_restart");
    expect(ops).toContain("session_restart_done");
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ tag: "session-manager", op: "session_restart", agentId, sessionId: id }), expect.any(String));
    expect(analytics.trackServerEvent).toHaveBeenCalledWith("session_restarted", { agent: agentId, scope: "session" });
  });
});

describe("restartSession — a running turn", () => {
  it("is cancelled first (the Stop path), pending approvals resolve as cancelled, and the busy state ends", async () => {
    const id = await openChat("claude-code", "busy");
    const c = conn.current;
    let settle!: (v: { stopReason: string }) => void;
    c.prompt.mockReturnValueOnce(new Promise((r) => { settle = r; }));
    // What both adapters do: the close ends the running prompt as cancelled.
    c.closeSession.mockImplementation(async () => { settle({ stopReason: "cancelled" }); return {}; });
    const resolveApproval = vi.fn();
    const sending = sm.sendMessage(id, "long job");
    await Promise.resolve();
    sm.getSession(id)!.pendingApprovals.set("p1", {
      pendingId: "p1", toolCall: { toolCallId: "t1" }, options: [], resolve: resolveApproval, createdAt: 0,
    });
    const events = eventsOf(id);
    expect(isSessionMidTurn(sm.getSession(id))).toBe(true);

    await sm.restartSession(id);
    await sending;

    expect(c.cancel).toHaveBeenCalledWith({ sessionId: id });
    expect(c.cancel.mock.invocationCallOrder[0]).toBeLessThan(c.closeSession.mock.invocationCallOrder[0]);
    expect(resolveApproval).toHaveBeenCalledWith({ outcome: { outcome: "cancelled" } });
    expect(events).toContainEqual({ type: "agent-permission-resolved", pendingId: "p1", outcome: { kind: "cancelled" } });
    // Exactly one terminal for the cancelled turn — the client's Stop button goes away on it.
    expect(events.filter((e) => e.type === "agent-complete")).toEqual([{ type: "agent-complete", stopReason: "cancelled" }]);
    expect(isSessionMidTurn(sm.getSession(id))).toBe(false);
    expect(sm.hasActiveSession(id)).toBe(true);
  });

  it("ends a turn the adapter never settles itself, and that prompt's late settle changes nothing", async () => {
    const id = await openChat("codex", "wedged-turn");
    const c = conn.current;
    let settle!: (v: { stopReason: string }) => void;
    c.prompt.mockReturnValueOnce(new Promise((r) => { settle = r; }));
    const sending = sm.sendMessage(id, "long job");
    await Promise.resolve();
    const events = eventsOf(id);

    await sm.restartSession(id);

    expect(events.filter((e) => e.type === "agent-complete")).toEqual([{ type: "agent-complete", stopReason: "cancelled" }]);
    expect(isSessionMidTurn(sm.getSession(id))).toBe(false);

    // A new turn is running when the stale prompt finally answers: it must not end that one.
    let settleNew!: (v: { stopReason: string }) => void;
    c.prompt.mockReturnValueOnce(new Promise((r) => { settleNew = r; }));
    const next = sm.sendMessage(id, "next");
    await Promise.resolve();
    settle({ stopReason: "end_turn" });
    await sending;
    expect(events.filter((e) => e.type === "agent-complete")).toHaveLength(1);
    expect(sm.getSession(id)!.currentAgentMessage).not.toBeNull();
    expect(isSessionMidTurn(sm.getSession(id))).toBe(true);
    settleNew({ stopReason: "end_turn" });
    await next;
    expect(events.filter((e) => e.type === "agent-complete")).toHaveLength(2);
  });
});

describe("restartSession — bounded on a dead or hung adapter", () => {
  it("an adapter that never answers the close is replaced, and the chat loads on the new process", async () => {
    const id = await openChat("claude-code", "hung-close");
    const other = await (async () => {
      conn.current.newSession.mockResolvedValueOnce({ sessionId: "idle-other" });
      return sm.createSession();
    })();
    const old = conn.current;
    const fresh = makeConn();
    old.closeSession.mockReturnValue(new Promise(() => {}));
    pm.restartProcess.mockImplementation(async () => { conn.current = fresh; });
    const events = eventsOf(id);
    vi.useFakeTimers();

    const restarting = sm.restartSession(id);
    await vi.advanceTimersByTimeAsync(RESTART_CLOSE_TIMEOUT_MS + 10);
    const result = await restarting;

    expect(result).toEqual({ agentId: "claude-code", processRestarted: true });
    expect(pm.restartProcess).toHaveBeenCalledWith("claude-code");
    expect(fresh.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id }));
    expect(sm.hasActiveSession(id)).toBe(true);
    // The idle chat that shared the process lost its ACP session with it: it loads again on its next message.
    expect(sm.hasActiveSession(other)).toBe(false);
    expect(restartPhases(events)).toEqual(["started", "done"]);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ op: "session_restart_process", agentId: "claude-code", sessionId: id }), expect.any(String));
    expect(analytics.trackServerEvent).toHaveBeenCalledWith("session_restarted", { agent: "claude-code", scope: "agent_process" });
  });

  it("a load that never answers is bounded, then the process is replaced", async () => {
    const id = await openChat("codex", "hung-load");
    const old = conn.current;
    let rejectStale!: (e: Error) => void;
    old.loadSession.mockReturnValue(new Promise((_, rej) => { rejectStale = rej; }));
    const fresh = makeConn();
    // Killing the old process closes its connection, which rejects what was pending on it.
    pm.restartProcess.mockImplementation(async () => { rejectStale(new Error("ACP connection closed")); conn.current = fresh; });
    vi.useFakeTimers();

    const restarting = sm.restartSession(id);
    await vi.advanceTimersByTimeAsync(RESTART_LOAD_TIMEOUT_MS + 10);
    const result = await restarting;

    expect(result.processRestarted).toBe(true);
    expect(fresh.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id }));
    expect(sm.hasActiveSession(id)).toBe(true);
  });

  it("never replaces a process another chat is still working on — it fails, in plain words, within the bound", async () => {
    const id = await openChat("claude-code", "hung-2");
    conn.current.newSession.mockResolvedValueOnce({ sessionId: "working-other" });
    const other = await sm.createSession();
    conn.current.prompt.mockReturnValueOnce(new Promise(() => {}));
    void sm.sendMessage(other, "render the intro");
    await Promise.resolve();
    conn.current.closeSession.mockImplementation(({ sessionId }: { sessionId: string }) =>
      sessionId === id ? new Promise(() => {}) : Promise.resolve({}),
    );
    const events = eventsOf(id);
    vi.useFakeTimers();

    const restarting = sm.restartSession(id).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RESTART_CLOSE_TIMEOUT_MS + 10);
    const err = await restarting;

    expect(err).toBeInstanceOf(SessionRestartError);
    expect((err as SessionRestartError).code).toBe("agent_busy");
    expect((err as Error).message).toMatch(/another chat/i);
    expect(pm.restartProcess).not.toHaveBeenCalled();
    expect(isSessionMidTurn(sm.getSession(other))).toBe(true);
    expect(sm.hasActiveSession(other)).toBe(true);
    expect(events.filter((e) => e.type === "session-restart")).toEqual([
      { type: "session-restart", phase: "started" },
      { type: "session-restart", phase: "failed", error: (err as Error).message },
    ]);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ op: "session_restart_failed", code: "agent_busy" }), expect.any(String));
  });

  it("fails within the bound when the replaced process still does not load the chat", async () => {
    const id = await openChat("claude-code", "hung-3");
    conn.current.closeSession.mockReturnValue(new Promise(() => {}));
    const stillHung = makeConn();
    stillHung.loadSession.mockReturnValue(new Promise(() => {}));
    pm.restartProcess.mockImplementation(async () => { conn.current = stillHung; });
    vi.useFakeTimers();

    const restarting = sm.restartSession(id).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RESTART_CLOSE_TIMEOUT_MS + RESTART_LOAD_TIMEOUT_MS + 10);
    const err = await restarting;

    expect(err).toBeInstanceOf(SessionRestartError);
    expect((err as SessionRestartError).code).toBe("agent_unresponsive");
  });

  it("a process that already died (crash handled) is simply started again by the load", async () => {
    const id = await openChat("claude-code", "crashed");
    sm.handleProcessCrash("claude-code", "Process exited with code 1");
    // The process manager dropped the dead process: no connection until something warms one.
    const fresh = makeConn();
    let live: Conn | null = null;
    pm.getConnection.mockImplementation(() => live as Conn);
    pm.warmProcess.mockImplementation(async () => { live = fresh; });

    const result = await sm.restartSession(id);

    expect(result.processRestarted).toBe(false);
    expect(fresh.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id }));
    expect(sm.hasActiveSession(id)).toBe(true);
  });
});

describe("restartSession — other cases", () => {
  it("an unknown chat is refused as not_found", async () => {
    await expect(sm.restartSession("nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("a load the adapter REJECTS fails as load_failed with the reason, and the chat stays loadable", async () => {
    const id = await openChat("codex", "rejects");
    conn.current.loadSession.mockRejectedValueOnce(new Error("thread not found"));
    const events = eventsOf(id);

    const err = await sm.restartSession(id).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SessionRestartError);
    expect((err as SessionRestartError).code).toBe("load_failed");
    expect((err as Error).message).toContain("thread not found");
    expect(restartPhases(events)).toEqual(["started", "failed"]);
    expect(pm.restartProcess).not.toHaveBeenCalled();
  });

  it("an inactive chat is closed on the adapter (it may still hold it) and loaded", async () => {
    conn.current.listSessions.mockResolvedValueOnce({ sessions: [{ sessionId: "past", title: "Past", updatedAt: null }], nextCursor: null });
    await sm.loadInitialSessions("claude-code");
    conn.current.closeSession.mockRejectedValueOnce(new Error("Session not found"));

    await sm.restartSession("past");

    expect(conn.current.closeSession).toHaveBeenCalledWith({ sessionId: "past" });
    expect(conn.current.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "past" }));
    expect(sm.hasActiveSession("past")).toBe(true);
  });

  it("two restarts of one chat at once share one close and one load", async () => {
    const id = await openChat("claude-code", "twice");
    conn.current.closeSession.mockClear();
    conn.current.loadSession.mockClear();

    await Promise.all([sm.restartSession(id), sm.restartSession(id)]);

    expect(conn.current.closeSession).toHaveBeenCalledTimes(1);
    expect(conn.current.loadSession).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 (review of 6d4f169f)
// ---------------------------------------------------------------------------

describe("restartSession — one overall deadline", () => {
  it("fails as timed_out at RESTART_DEADLINE_MS, stops the abandoned run, and a later Restart starts afresh", async () => {
    const id = await openChat("claude-code", "deadline");
    conn.current.closeSession.mockReturnValue(new Promise(() => {}));
    let finishReplace!: () => void;
    const fresh = makeConn();
    pm.restartProcess.mockImplementation(() => new Promise<void>((r) => { finishReplace = () => { conn.current = fresh; r(); }; }));
    const events = eventsOf(id);
    vi.useFakeTimers();

    const first = sm.restartSession(id).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RESTART_DEADLINE_MS + 10);
    const err = await first;

    expect(err).toBeInstanceOf(SessionRestartError);
    expect((err as SessionRestartError).code).toBe("timed_out");
    expect((err as Error).message).toMatch(/Restart again/i);
    expect(restartPhases(events)).toEqual(["started", "failed"]);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ op: "session_restart_failed", code: "timed_out" }), expect.any(String));

    // The abandoned run finishing late says nothing more and loads nothing.
    finishReplace();
    await vi.advanceTimersByTimeAsync(RESTART_STALE_SETTLE_MS + 10);
    expect(restartPhases(events)).toEqual(["started", "failed"]);
    expect(fresh.loadSession).not.toHaveBeenCalled();
    expect(analytics.trackServerEvent).not.toHaveBeenCalled();

    // Recoverable: a new Restart is a new run (not joined to the old one) and loads the chat.
    pm.restartProcess.mockImplementation(async () => { conn.current = fresh; });
    const second = await sm.restartSession(id);
    expect(second.agentId).toBe("claude-code");
    expect(fresh.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id }));
    expect(sm.hasActiveSession(id)).toBe(true);
    expect(restartPhases(events)).toEqual(["started", "failed", "started", "done"]);
  });
});

describe("restartSession — nothing from before the restart settles into the reloaded chat", () => {
  it("a prompt sent (from another window) while the close is awaited is ended by the restart, and its late answer is ignored", async () => {
    const id = await openChat("claude-code", "late-prompt");
    const c = conn.current;
    let finishClose!: () => void;
    c.closeSession.mockImplementationOnce(() => new Promise((r) => { finishClose = () => r({}); }));
    let settleLate!: (v: { stopReason: string }) => void;
    c.prompt.mockReturnValueOnce(new Promise((r) => { settleLate = r; }));
    const events = eventsOf(id);

    const restarting = sm.restartSession(id);
    await vi.waitFor(() => expect(c.closeSession).toHaveBeenCalled());
    const lateSend = sm.sendMessage(id, "sent from the other window");
    await Promise.resolve();
    finishClose();
    await restarting;

    // The restart ended that turn for the chat, once.
    expect(events.filter((e) => e.type === "agent-complete")).toEqual([{ type: "agent-complete", stopReason: "cancelled" }]);
    expect(isSessionMidTurn(sm.getSession(id))).toBe(false);

    // A new turn is running when the stale prompt answers.
    c.prompt.mockReturnValueOnce(new Promise(() => {}));
    void sm.sendMessage(id, "after the restart");
    await Promise.resolve();
    settleLate({ stopReason: "end_turn" });
    await lateSend;
    expect(events.filter((e) => e.type === "agent-complete")).toHaveLength(1);
    expect(sm.getSession(id)!.currentAgentMessage).not.toBeNull();
    expect(isSessionMidTurn(sm.getSession(id))).toBe(true);
  });

  it("a cancel that outlived its bound does not cancel approval cards opened after the restart", async () => {
    const id = await openChat("codex", "late-cancel");
    const c = conn.current;
    c.prompt.mockReturnValueOnce(new Promise(() => {}));
    void sm.sendMessage(id, "long job");
    await Promise.resolve();
    let answerCancel!: () => void;
    c.cancel.mockImplementationOnce(() => new Promise<void>((r) => { answerCancel = r; }));
    vi.useFakeTimers();

    const restarting = sm.restartSession(id);
    await vi.advanceTimersByTimeAsync(RESTART_CLOSE_TIMEOUT_MS + 10);
    await restarting;
    expect(sm.hasActiveSession(id)).toBe(true);

    const resolveNew = vi.fn();
    sm.getSession(id)!.pendingApprovals.set("after", {
      pendingId: "after", toolCall: { toolCallId: "t2" }, options: [], resolve: resolveNew, createdAt: 0,
    });
    answerCancel();
    await vi.advanceTimersByTimeAsync(0);

    expect(resolveNew).not.toHaveBeenCalled();
    expect(sm.getSession(id)!.pendingApprovals.has("after")).toBe(true);
  });

  it("a crash's late prompt failure emits nothing into the reloaded chat (generic epoch guard)", async () => {
    const id = await openChat("claude-code", "crash-late");
    let fail!: (e: Error) => void;
    conn.current.prompt.mockReturnValueOnce(new Promise((_, rej) => { fail = rej; }));
    const sending = sm.sendMessage(id, "work");
    await Promise.resolve();
    sm.handleProcessCrash("claude-code", "Process exited with code 1");
    await sm.activateSession(id);
    const events = eventsOf(id);

    fail(new Error("ACP connection closed"));
    await sending;

    expect(events.filter((e) => e.type === "agent-status" && e.status === "error")).toEqual([]);
    expect(events.filter((e) => e.type === "agent-complete")).toEqual([]);
  });
});

describe("activation retries once under the fallback MCP entry name (Codex libi-app chats)", () => {
  /** What codex-acp 1.10.0 answers when libi's `libi` entry collides with a stdio [mcp_servers.libi]. */
  const collisionError = () => ({
    code: -32603,
    message: "Internal error",
    data: "failed to load configuration: url is not supported for stdio\nin `mcp_servers.libi`\n",
  });
  const FALLBACK = { type: "http", name: "libi-app", url: "http://127.0.0.1:3457/mcp?agent=codex", headers: [] };

  it("a restart (and any resume) of such a chat loads it under the fallback name", async () => {
    const { getMcpServersForAcpFallback } = await import("@/lib/mcp-config");
    vi.mocked(getMcpServersForAcpFallback).mockReturnValue([FALLBACK] as never);
    const id = await openChat("codex", "fallback-chat");
    conn.current.loadSession.mockRejectedValueOnce(collisionError());

    const result = await sm.restartSession(id);

    expect(result.processRestarted).toBe(false);
    const names = conn.current.loadSession.mock.calls.map((cl) => (cl[0] as { mcpServers: { name: string }[] }).mcpServers.map((m) => m.name).join(","));
    expect(names).toEqual(["libi", "libi-app"]);
    expect(sm.hasActiveSession(id)).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ op: "mcp_entry_collision_retry", agentId: "codex", reason: "load", fallbackNames: ["libi-app"] }), expect.stringMatching(/twice/i));
  });

  it("retries only that error, and only once — the original error propagates", async () => {
    const id = await openChat("codex", "fallback-twice");
    conn.current.loadSession.mockRejectedValue(collisionError());
    const err = await sm.restartSession(id).catch((e: unknown) => e);
    expect((err as SessionRestartError).code).toBe("load_failed");
    expect((err as Error).message).toContain("failed to load configuration: url is not supported for stdio");
    expect(conn.current.loadSession).toHaveBeenCalledTimes(2);

    conn.current.loadSession.mockReset().mockRejectedValue(new Error("thread not found"));
    await sm.restartSession(id).catch(() => {});
    expect(conn.current.loadSession).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Fix round 2: a turn retired by ANY deactivation still ends once for the chat
// ---------------------------------------------------------------------------

describe("a deactivation that retires an in-flight prompt ends its turn exactly once", () => {
  const completes = (events: AgentEvent[]) => events.filter((e) => e.type === "agent-complete");

  async function midTurn(agentId: "claude-code" | "codex", id: string) {
    const chat = await openChat(agentId, id);
    let settle!: (v: { stopReason: string }) => void;
    conn.current.prompt.mockReturnValueOnce(new Promise((r) => { settle = r; }));
    const sending = sm.sendMessage(chat, "long job");
    await Promise.resolve();
    return { chat, sending, settle: (v: { stopReason: string }) => settle(v) };
  }

  it("scheduleSessionReload mid-turn (libi.restart_acp_session), the adapter answering the close first", async () => {
    const { chat, sending, settle } = await midTurn("claude-code", "reload-mid");
    const events = eventsOf(chat);

    sm.scheduleSessionReload(chat);
    await vi.waitFor(() => expect(sm.hasActiveSession(chat)).toBe(true));
    await vi.waitFor(() => expect(conn.current.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: chat })));

    // The retired turn's end waits (up to RETIRED_TURN_GRACE_MS) for the prompt's own answer (C5).
    expect(completes(events)).toEqual([]);
    settle({ stopReason: "cancelled" });
    await sending;
    expect(completes(events)).toEqual([{ type: "agent-complete", stopReason: "cancelled" }]);
  });

  it("deactivateSession mid-turn (eviction, /api/agent/stop, agent switch)", async () => {
    const { chat, sending, settle } = await midTurn("codex", "deact-mid");
    const events = eventsOf(chat);

    await sm.deactivateSession(chat);
    settle({ stopReason: "end_turn" });
    await sending;

    // Ended once, with the reason the turn really ended (C5).
    expect(completes(events)).toEqual([{ type: "agent-complete", stopReason: "end_turn" }]);
  });

  it("a close that settles the prompt itself (what both adapters do) is still one agent-complete — the prompt's own", async () => {
    const { chat, sending, settle } = await midTurn("claude-code", "close-settles");
    conn.current.closeSession.mockImplementationOnce(async () => { settle({ stopReason: "cancelled" }); return {}; });
    const events = eventsOf(chat);

    await sm.deactivateSession(chat);
    await sending;

    expect(completes(events)).toEqual([{ type: "agent-complete", stopReason: "cancelled" }]);
  });

  it("a crash ends the turn once, before its error, and the late rejection adds nothing", async () => {
    const chat = await openChat("claude-code", "crash-mid");
    let fail!: (e: Error) => void;
    conn.current.prompt.mockReturnValueOnce(new Promise((_, rej) => { fail = rej; }));
    const sending = sm.sendMessage(chat, "work");
    await Promise.resolve();
    const events = eventsOf(chat);

    sm.handleProcessCrash("claude-code", "Process exited with code 1");
    fail(new Error("ACP connection closed"));
    await sending;

    const terminal = events.filter((e) => e.type === "agent-complete" || (e.type === "agent-status" && e.status === "error"));
    expect(terminal).toEqual([
      { type: "agent-complete", stopReason: "cancelled" },
      { type: "agent-status", status: "error", error: "Process exited with code 1" },
    ]);
  });

  it("a normal turn is unchanged: one agent-complete with its own stop reason, and a later deactivation adds none", async () => {
    const chat = await openChat("codex", "normal");
    const events = eventsOf(chat);
    await sm.sendMessage(chat, "hi");
    await sm.deactivateSession(chat);
    expect(completes(events)).toEqual([{ type: "agent-complete", stopReason: "end_turn" }]);
  });

  it("the Stop button (cancelTurn) keeps the session and ends in exactly one agent-complete — the adapter's", async () => {
    const { chat, sending, settle } = await midTurn("claude-code", "stop");
    const events = eventsOf(chat);
    await sm.cancelTurn(chat);
    settle({ stopReason: "cancelled" });
    await sending;
    expect(sm.hasActiveSession(chat)).toBe(true);
    expect(completes(events)).toEqual([{ type: "agent-complete", stopReason: "cancelled" }]);
  });
});

// ---------------------------------------------------------------------------
// Final whole-branch review (I2, F7)
// ---------------------------------------------------------------------------

describe("restartSession — the standby comes back whenever the process was replaced (I2)", () => {
  /** Opens a chat and lets the standby that replenishes after it become ready. */
  async function openChatWithStandby(sessionId: string): Promise<string> {
    const id = await openChat("claude-code", sessionId);
    await sm.createStandbySession();
    expect(sm.isStandbyReady()).toBe(true);
    return id;
  }

  it("after agent_unresponsive (the replaced process still does not load the chat)", async () => {
    const id = await openChatWithStandby("std-unresponsive");
    conn.current.closeSession.mockReturnValue(new Promise(() => {}));
    const stillHung = makeConn();
    stillHung.loadSession.mockReturnValue(new Promise(() => {}));
    stillHung.newSession.mockResolvedValue({ sessionId: "standby-after" });
    pm.restartProcess.mockImplementation(async () => { conn.current = stillHung; });
    vi.useFakeTimers();

    const restarting = sm.restartSession(id).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RESTART_CLOSE_TIMEOUT_MS + RESTART_LOAD_TIMEOUT_MS + 10);
    const err = await restarting;
    await vi.advanceTimersByTimeAsync(0);

    expect((err as SessionRestartError).code).toBe("agent_unresponsive");
    expect(stillHung.newSession).toHaveBeenCalled();
    expect(sm.isStandbyReady()).toBe(true);
  });

  it("after load_failed on the new process", async () => {
    const id = await openChatWithStandby("std-load-failed");
    conn.current.closeSession.mockReturnValue(new Promise(() => {}));
    const fresh = makeConn();
    fresh.loadSession.mockRejectedValue(new Error("thread not found"));
    fresh.newSession.mockResolvedValue({ sessionId: "standby-after" });
    pm.restartProcess.mockImplementation(async () => { conn.current = fresh; });
    vi.useFakeTimers();

    const restarting = sm.restartSession(id).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RESTART_CLOSE_TIMEOUT_MS + 10);
    const err = await restarting;
    await vi.advanceTimersByTimeAsync(0);

    expect((err as SessionRestartError).code).toBe("load_failed");
    expect(sm.isStandbyReady()).toBe(true);
  });

  it("after the 90 s deadline abandoned the run, once the replacement finishes", async () => {
    const id = await openChatWithStandby("std-abandoned");
    conn.current.closeSession.mockReturnValue(new Promise(() => {}));
    const fresh = makeConn();
    fresh.newSession.mockResolvedValue({ sessionId: "standby-after" });
    let finishReplace!: () => void;
    pm.restartProcess.mockImplementation(() => new Promise<void>((r) => { finishReplace = () => { conn.current = fresh; r(); }; }));
    vi.useFakeTimers();

    const first = sm.restartSession(id).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RESTART_DEADLINE_MS + 10);
    expect(((await first) as SessionRestartError).code).toBe("timed_out");
    expect(sm.isStandbyReady()).toBe(false);

    finishReplace();
    await vi.advanceTimersByTimeAsync(RESTART_STALE_SETTLE_MS + 10);

    expect(fresh.loadSession).not.toHaveBeenCalled(); // the abandoned run still loads nothing
    expect(sm.isStandbyReady()).toBe(true);
  });

  it("when restartProcess itself throws, the agent is started again once in the background, then the standby", async () => {
    const id = await openChatWithStandby("std-restart-threw");
    conn.current.closeSession.mockReturnValue(new Promise(() => {}));
    const fresh = makeConn();
    fresh.newSession.mockResolvedValue({ sessionId: "standby-after" });
    let live: Conn | null = conn.current;
    pm.getConnection.mockImplementation(() => live as Conn);
    // The old process is gone and the new one never initialized.
    pm.restartProcess.mockImplementation(async () => { live = null; throw new Error("ACP initialize timed out"); });
    pm.warmProcess.mockImplementation(async () => { live = fresh; });
    vi.useFakeTimers();

    const restarting = sm.restartSession(id).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RESTART_CLOSE_TIMEOUT_MS + 10);
    const err = await restarting;
    await vi.advanceTimersByTimeAsync(0);

    expect((err as SessionRestartError).code).toBe("agent_unresponsive");
    expect(pm.warmProcess).toHaveBeenCalledWith("claude-code");
    expect(sm.isStandbyReady()).toBe(true);
  });

  it("but a spawn REFUSAL (no usable CLI) starts nothing again — its remedy is the user's", async () => {
    const { AgentSpawnRefusedError } = await import("@/lib/agents/spawn-refused-error");
    const id = await openChatWithStandby("std-refused");
    conn.current.closeSession.mockReturnValue(new Promise(() => {}));
    pm.restartProcess.mockRejectedValue(new AgentSpawnRefusedError("claude-code", { code: "cli-missing", message: "Claude Code isn't installed" } as never));
    pm.warmProcess.mockClear();
    vi.useFakeTimers();

    const restarting = sm.restartSession(id).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RESTART_CLOSE_TIMEOUT_MS + 10);
    await restarting;
    await vi.advanceTimersByTimeAsync(0);

    expect(pm.warmProcess).not.toHaveBeenCalled();
    expect(sm.getReadiness("claude-code").state).toBe("not-installed");
  });
});

describe("restartSession — a stale load that finishes on the OLD process (F7)", () => {
  it("is dropped, so the chat really loads on the new process", async () => {
    const id = await openChat("codex", "stale-ok");
    const old = conn.current;
    let resolveStale!: () => void;
    old.loadSession.mockReturnValue(new Promise((r) => { resolveStale = () => r({}); }));
    const fresh = makeConn();
    // The old load answers just as the process is killed — on the process that is going away.
    pm.restartProcess.mockImplementation(async () => { resolveStale(); conn.current = fresh; });
    vi.useFakeTimers();

    const restarting = sm.restartSession(id);
    await vi.advanceTimersByTimeAsync(RESTART_LOAD_TIMEOUT_MS + 10);
    const result = await restarting;

    expect(result.processRestarted).toBe(true);
    expect(fresh.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id }));
    expect(sm.hasActiveSession(id)).toBe(true);
    expect(pm.unregisterSessionId).toHaveBeenCalledWith("codex", id);
  });
});

// ---------------------------------------------------------------------------
// Follow-ups (G3, 2026-09-25): C1, C2, C4, C5
// ---------------------------------------------------------------------------

describe("every prompt a drop retires ends its turn exactly once, with its real stop reason (C1, C2, C5)", () => {
  const completes = (events: AgentEvent[]) => events.filter((e) => e.type === "agent-complete");

  async function midTurn(agentId: "claude-code" | "codex", id: string) {
    const chat = await openChat(agentId, id);
    let settle!: (v: { stopReason: string }) => void;
    conn.current.prompt.mockReturnValueOnce(new Promise((r) => { settle = r; }));
    const sending = sm.sendMessage(chat, "long job");
    await Promise.resolve();
    return { chat, sending, settle: (v: { stopReason: string }) => settle(v) };
  }

  it("C1: a cancelled prompt the silence bound already released is still ended once by a restart", async () => {
    const { chat, sending, settle } = await midTurn("codex", "released");
    const events = eventsOf(chat);
    vi.useFakeTimers();
    await sm.cancelTurn(chat);
    await vi.advanceTimersByTimeAsync(CANCEL_SETTLE_TIMEOUT_MS + 10);
    // Released: the chat is no longer busy, but the turn was never ended for the client.
    expect(isSessionMidTurn(sm.getSession(chat))).toBe(false);
    expect(completes(events)).toEqual([]);

    await sm.restartSession(chat);
    expect(completes(events)).toEqual([{ type: "agent-complete", stopReason: "cancelled" }]);

    settle({ stopReason: "cancelled" });
    await sending;
    await vi.advanceTimersByTimeAsync(RETIRED_TURN_GRACE_MS + 10);
    expect(completes(events)).toHaveLength(1);
  });

  it("C1: a released prompt that settles on its own before any restart ends its turn itself, and a restart adds none", async () => {
    const { chat, sending, settle } = await midTurn("codex", "released-settles");
    const events = eventsOf(chat);
    vi.useFakeTimers();
    await sm.cancelTurn(chat);
    await vi.advanceTimersByTimeAsync(CANCEL_SETTLE_TIMEOUT_MS + 10);
    settle({ stopReason: "cancelled" });
    await sending;
    expect(completes(events)).toEqual([{ type: "agent-complete", stopReason: "cancelled" }]);

    await sm.restartSession(chat);
    await vi.advanceTimersByTimeAsync(RETIRED_TURN_GRACE_MS + 10);
    expect(completes(events)).toHaveLength(1);
  });

  it("C2: a per-session subscriber (onEvent) gets an event sent while the close is awaited once", async () => {
    // Independent of when the retired turn ends: the deactivation copies the listener to the pending
    // set before it awaits the close, so during the close it is in both sets.
    const chat = await openChat("claude-code", "per-session");
    conn.current.closeSession.mockImplementationOnce(async () => {
      sm.emitForSession(chat, { type: "agent-status", status: "connecting" });
      return {};
    });
    const got: AgentEvent[] = [];
    sm.onEvent(chat, (e) => got.push(e));

    await sm.deactivateSession(chat);

    expect(got).toEqual([{ type: "agent-status", status: "connecting" }]);
  });

  it("C2: …and a retired turn's end once, when it comes after the close", async () => {
    const { chat, sending, settle } = await midTurn("claude-code", "per-session-late");
    const got: AgentEvent[] = [];
    sm.onEvent(chat, (e) => got.push(e));

    await sm.deactivateSession(chat);
    settle({ stopReason: "cancelled" });
    await sending;

    expect(completes(got)).toEqual([{ type: "agent-complete", stopReason: "cancelled" }]);
  });

  it("C2: …and so does an event sent while the close is awaited (the close settling the prompt)", async () => {
    const { chat, sending, settle } = await midTurn("claude-code", "per-session-close");
    conn.current.closeSession.mockImplementationOnce(async () => { settle({ stopReason: "cancelled" }); return {}; });
    const got: AgentEvent[] = [];
    sm.onEvent(chat, (e) => got.push(e));

    await sm.deactivateSession(chat);
    await sending;

    expect(completes(got)).toEqual([{ type: "agent-complete", stopReason: "cancelled" }]);
  });

  it("C5: a retired prompt that really finished is reported with its own stop reason, and proves the agent ready", async () => {
    const { chat, sending, settle } = await midTurn("codex", "retired-end-turn");
    (sm as unknown as { readiness: Map<string, unknown> }).readiness.set("codex", { state: "needs-auth", message: "x" });
    const events = eventsOf(chat);

    await sm.deactivateSession(chat); // the adapter answered the close before the prompt
    settle({ stopReason: "end_turn" });
    await sending;

    expect(completes(events)).toEqual([{ type: "agent-complete", stopReason: "end_turn" }]);
    expect(sm.getReadiness("codex").state).toBe("ready");
  });

  it("C5: one that never answers is ended as cancelled after the grace, and its late answer adds nothing", async () => {
    const { chat, sending, settle } = await midTurn("claude-code", "retired-silent");
    const events = eventsOf(chat);
    vi.useFakeTimers();

    await sm.deactivateSession(chat);
    await vi.advanceTimersByTimeAsync(RETIRED_TURN_GRACE_MS + 10);
    expect(completes(events)).toEqual([{ type: "agent-complete", stopReason: "cancelled" }]);

    settle({ stopReason: "end_turn" });
    await sending;
    expect(completes(events)).toHaveLength(1);
  });

  it("C5: a new message before the retired prompt answers ends the old turn first, and the late answer cannot end the new one", async () => {
    const { chat, sending, settle } = await midTurn("codex", "retired-then-send");
    const events = eventsOf(chat);
    await sm.deactivateSession(chat);
    await sm.activateSession(chat);

    conn.current.prompt.mockReturnValueOnce(new Promise(() => {}));
    void sm.sendMessage(chat, "next");
    await Promise.resolve();
    const order = events.filter((e) => e.type === "agent-complete" || (e.type === "agent-status" && e.status === "thinking"));
    expect(order).toEqual([
      { type: "agent-complete", stopReason: "cancelled" },
      { type: "agent-status", status: "thinking" },
    ]);

    settle({ stopReason: "end_turn" });
    await sending;
    expect(completes(events)).toHaveLength(1);
    expect(isSessionMidTurn(sm.getSession(chat))).toBe(true);
  });
});

describe("restartSession — a Restart never overlaps a previous run that is still unwinding (C4)", () => {
  it("waits for the abandoned run to stop (it was inside the process replacement), then runs once on its own", async () => {
    const id = await openChat("claude-code", "overlap");
    conn.current.closeSession.mockReturnValue(new Promise(() => {}));
    const fresh = makeConn();
    let finishReplace!: () => void;
    pm.restartProcess.mockImplementation(() => new Promise<void>((r) => { finishReplace = () => { conn.current = fresh; r(); }; }));
    const events = eventsOf(id);
    vi.useFakeTimers();

    const first = sm.restartSession(id).catch((e: unknown) => e);
    expect(sm.isRestarting(id)).toBe(true);
    await vi.advanceTimersByTimeAsync(RESTART_DEADLINE_MS + 10);
    expect(((await first) as SessionRestartError).code).toBe("timed_out");
    // Its failed was sent: nothing more is to come from it.
    expect(sm.isRestarting(id)).toBe(false);

    // Asked again while the abandoned run still waits on pm.restartProcess.
    const second = sm.restartSession(id);
    await vi.advanceTimersByTimeAsync(RESTART_CLOSE_TIMEOUT_MS + 10);
    expect(pm.restartProcess).toHaveBeenCalledTimes(1);
    expect(fresh.closeSession).not.toHaveBeenCalled();
    expect(restartPhases(events)).toEqual(["started", "failed"]);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ op: "session_restart_waits", sessionId: id }), expect.any(String));

    // Still "restarting" for a window that asks (C3): the second run's done is still to come.
    expect(sm.isRestarting(id)).toBe(true);

    finishReplace();
    await vi.advanceTimersByTimeAsync(RESTART_STALE_SETTLE_MS + 10);
    const result = await second;
    expect(sm.isRestarting(id)).toBe(false);

    expect(result).toEqual({ agentId: "claude-code", processRestarted: false });
    expect(pm.restartProcess).toHaveBeenCalledTimes(1);
    expect(fresh.closeSession).toHaveBeenCalledWith({ sessionId: id });
    expect(fresh.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id }));
    expect(sm.hasActiveSession(id)).toBe(true);
    expect(restartPhases(events)).toEqual(["started", "failed", "started", "done"]);
  });

  it("two Restarts asked for during that wait still share one run", async () => {
    const id = await openChat("codex", "overlap-twice");
    conn.current.closeSession.mockReturnValue(new Promise(() => {}));
    const fresh = makeConn();
    let finishReplace!: () => void;
    pm.restartProcess.mockImplementation(() => new Promise<void>((r) => { finishReplace = () => { conn.current = fresh; r(); }; }));
    vi.useFakeTimers();

    const first = sm.restartSession(id).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RESTART_DEADLINE_MS + 10);
    await first;

    const a = sm.restartSession(id);
    const b = sm.restartSession(id);
    expect(b).toBe(a);
    finishReplace();
    await vi.advanceTimersByTimeAsync(RESTART_STALE_SETTLE_MS + 10);
    await Promise.all([a, b]);
    expect(fresh.loadSession).toHaveBeenCalledTimes(1);
  });
});

describe("round 1 of the G3 review", () => {
  const completes = (events: AgentEvent[]) => events.filter((e) => e.type === "agent-complete");

  it("the wait for an abandoned run that never stops is bounded: the Restart fails as timed_out, and nothing overlaps", async () => {
    const id = await openChat("claude-code", "stuck-forever");
    conn.current.closeSession.mockReturnValue(new Promise(() => {}));
    pm.restartProcess.mockImplementation(() => new Promise<void>(() => {})); // a step that hangs for good
    const events = eventsOf(id);
    vi.useFakeTimers();

    const first = sm.restartSession(id).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RESTART_DEADLINE_MS + 10);
    expect(((await first) as SessionRestartError).code).toBe("timed_out");

    const second = sm.restartSession(id).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RESTART_DEADLINE_MS + 10);
    const err = (await second) as SessionRestartError;

    expect(err).toBeInstanceOf(SessionRestartError);
    expect(err.code).toBe("timed_out");
    expect(err.message).toMatch(/still stuck/i);
    expect(pm.restartProcess).toHaveBeenCalledTimes(1);
    expect(restartPhases(events)).toEqual(["started", "failed", "failed"]);
    expect(sm.isRestarting(id)).toBe(false); // a later Restart is not joined to a wedged one
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ op: "session_restart_failed", code: "timed_out", reason: "previous_run_stuck" }), expect.any(String));
  });

  it("a turn the restart cut short ends BEFORE the restart's failed", async () => {
    const chat = await openChat("codex", "owed-before-failed");
    conn.current.prompt.mockReturnValueOnce(new Promise(() => {})); // never answers
    void sm.sendMessage(chat, "long job");
    await Promise.resolve();
    conn.current.loadSession.mockRejectedValueOnce(new Error("thread not found"));
    const events = eventsOf(chat);

    await sm.restartSession(chat).catch(() => {});

    const terminals = events.filter((e) => e.type === "agent-complete" || e.type === "session-restart");
    expect(terminals).toEqual([
      { type: "session-restart", phase: "started" },
      { type: "agent-complete", stopReason: "cancelled" },
      { type: "session-restart", phase: "failed", error: expect.stringContaining("thread not found") },
    ]);
  });

  it("a crash ends a turn still owed from an earlier drop at once, before its error, and only once", async () => {
    const chat = await openChat("claude-code", "owed-then-crash");
    let settle!: (v: { stopReason: string }) => void;
    conn.current.prompt.mockReturnValueOnce(new Promise((r) => { settle = r; }));
    const sending = sm.sendMessage(chat, "long job");
    await Promise.resolve();
    await sm.deactivateSession(chat); // retired, its end owed
    await sm.activateSession(chat);
    const events = eventsOf(chat);

    sm.handleProcessCrash("claude-code", "Process exited with code 1");
    settle({ stopReason: "end_turn" });
    await sending;

    const terminal = events.filter((e) => e.type === "agent-complete" || (e.type === "agent-status" && e.status === "error"));
    expect(terminal).toEqual([
      { type: "agent-complete", stopReason: "cancelled" },
      { type: "agent-status", status: "error", error: "Process exited with code 1" },
    ]);
    expect(completes(events)).toHaveLength(1);
  });
});
