/**
 * Agent readiness — the honesty layer over ACP outcomes.
 *
 * The bug these cover: a codex user with no sign-in got `standby-ready
 * {ready:false}` and NOTHING else. `switchAgent` had already set the active
 * agent (green dot), `createStandbySession` swallowed the rejection in a bare
 * `logger.warn`, and `POST /api/agent/start` had returned `{success:true}`
 * before any of it ran. Readiness is only ever written from an OBSERVED
 * rejection, so these tests drive real `session/new` outcomes rather than
 * poking state.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { AgentReadiness } from "@/lib/agents/agent-readiness";

// ---------------------------------------------------------------------------
// Mocks — set up before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("@/lib/libi-home", () => ({
  getLibiAgentDir: vi.fn(() => "/tmp/libi-test-agent"),
  // The rest are required by lib/logger, imported transitively.
  getLibiHome: vi.fn(() => "/tmp/libi-test-home"),
  ensureLibiDirs: vi.fn(),
  getLibiLogDir: vi.fn(() => "/tmp/libi-test-logs"),
}));

// Session start's entry-shape diagnostic reads codex's MCP listing: a unit test never resolves or runs a real codex.
vi.mock("@/lib/agents/libi-registration", () => ({ readLibiCodexEntryShape: vi.fn(async () => "unknown") }));

vi.mock("@/lib/mcp-config", () => ({
  getMcpServersForAcp: vi.fn(() => []),
  onMcpConfigInvalidated: vi.fn(),
}));

vi.mock("@/lib/approval/settings", () => ({
  getApprovalMode: vi.fn(() => "auto"),
}));

vi.mock("@/lib/sessions/model-preferences", () => ({
  getAgentModelId: vi.fn(() => null),
  setAgentModelId: vi.fn(),
}));

const clearSignInConfirmation = vi.fn();
vi.mock("@/lib/agents/sign-in-confirmation", () => ({
  clearSignInConfirmation: (id: string) => clearSignInConfirmation(id),
}));

const trackServerEvent = vi.fn();
vi.mock("@/lib/analytics/server", () => ({
  trackServerEvent: (name: string, params?: Record<string, unknown>) => trackServerEvent(name, params),
}));

const { handlerCtorArgs } = vi.hoisted(() => ({ handlerCtorArgs: [] as unknown[][] }));
vi.mock("@/lib/agents/session-event-handler", () => ({
  // A `function`, not an arrow: `getEventHandler` calls it with `new`.
  SessionEventHandler: vi.fn().mockImplementation(function (...args: unknown[]) {
    handlerCtorArgs.push(args);
    return {
      createClient: vi.fn().mockReturnValue({}),
      cleanUserMessageParts: vi.fn(),
      attachJobProgressBridge: vi.fn(),
    };
  }),
}));

// ---------------------------------------------------------------------------

import { SessionManager } from "@/lib/sessions/session-manager";
import { AgentSpawnRefusedError } from "@/lib/agents/spawn-refused-error";
import { serverLogger } from "@/lib/logger";

/** The ACP rejection codex answers `session/new` with when not signed in. */
function authError(): Error & { code: number } {
  const err = new Error("Authentication required") as Error & { code: number };
  err.code = -32000;
  return err;
}

function createMockPm(opts: { canListSessions?: boolean } = {}) {
  const mockConnection = {
    listSessions: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
    newSession: vi.fn().mockResolvedValue({ sessionId: "s-new" }),
    loadSession: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
    setSessionMode: vi.fn().mockResolvedValue(undefined),
  };
  return {
    pm: {
      getConnection: vi.fn().mockReturnValue(mockConnection),
      warmProcess: vi.fn().mockResolvedValue(undefined),
      getCapabilitiesForAgent: vi
        .fn()
        .mockReturnValue({ canListSessions: opts.canListSessions ?? false }),
      registerSessionId: vi.fn(),
      unregisterSessionId: vi.fn(),
    },
    mockConnection,
  };
}

describe("SessionManager agent readiness", () => {
  let sm: SessionManager;
  let pm: ReturnType<typeof createMockPm>["pm"];
  let mockConnection: ReturnType<typeof createMockPm>["mockConnection"];
  let systemEvents: unknown[];

  beforeEach(() => {
    vi.clearAllMocks();
    const mocks = createMockPm();
    pm = mocks.pm;
    mockConnection = mocks.mockConnection;
    sm = new SessionManager();
    sm.setProcessManager(pm);
    systemEvents = [];
    sm.onSystemEvent((e) => systemEvents.push(e));
  });

  function readinessEvents() {
    return systemEvents.filter(
      (e): e is { type: string; agentId: string; readiness: AgentReadiness } =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: string }).type === "agent-readiness",
    );
  }

  it("defaults to unknown — never a claim of health", () => {
    expect(sm.getReadiness("codex")).toEqual({ state: "unknown" });
    expect(sm.getReadiness(null)).toEqual({ state: "unknown" });
  });

  // -------------------------------------------------------------------------
  // (a) auth rejection at session/new ⇒ needs-auth
  // -------------------------------------------------------------------------

  it("records needs-auth when the standby's session/new is rejected for auth", async () => {
    mockConnection.newSession.mockRejectedValue(authError());

    await sm.switchAgent("codex", { awaitStandbyMs: 2000 });

    const readiness = sm.getReadiness("codex");
    expect(readiness.state).toBe("needs-auth");
    if (readiness.state !== "needs-auth") throw new Error("unreachable");
    // The message comes from promptErrorNote, whose non-Claude branch had no
    // reachable call site before this wiring.
    expect(readiness.message).toBeTruthy();
    expect(readiness.message).toMatch(/signed in/i);
    expect(readiness.agentId).toBe("codex");
  });

  it("clears the wizard's sign-in confirmation on the observed rejection", async () => {
    mockConnection.newSession.mockRejectedValue(authError());
    await sm.switchAgent("codex", { awaitStandbyMs: 2000 });
    expect(clearSignInConfirmation).toHaveBeenCalledWith("codex");
  });

  it("reports the observed rejection as agent_auth_rejected { agent, stage } — codex at session-start", async () => {
    mockConnection.newSession.mockRejectedValue(authError());
    await sm.switchAgent("codex", { awaitStandbyMs: 2000 });
    const fired = trackServerEvent.mock.calls.filter(([name]) => name === "agent_auth_rejected");
    expect(fired).toEqual([["agent_auth_rejected", { agent: "codex", stage: "session-start" }]]);
  });

  it("a non-auth session/new failure reports no agent_auth_rejected — only an observed rejection counts", async () => {
    mockConnection.newSession.mockRejectedValue(new Error("transport closed"));
    await sm.switchAgent("codex", { awaitStandbyMs: 2000 });
    expect(trackServerEvent).not.toHaveBeenCalledWith("agent_auth_rejected", expect.anything());
  });

  // Claude's unauthenticated `session/new` SUCCEEDS; auth is rejected only at
  // `session/prompt` (observed on claude 2.1.245 and 2.1.267). These pin that a
  // clean standby never undoes a prompt rejection, and that a returned turn does.

  /** A claimed claude-code chat: the switch lands a standby (→ ready), the claim replenishes it. */
  async function claudeChat(): Promise<string> {
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    const sessionId = await sm.createSession();
    await new Promise((r) => setTimeout(r, 0));
    return sessionId;
  }

  it("claude-code: a prompt auth rejection is NOT undone by the next successful standby session/new, and the confirmation stays cleared", async () => {
    const sessionId = await claudeChat();
    expect(sm.getReadiness("claude-code")).toEqual({ state: "ready" });

    mockConnection.prompt.mockRejectedValueOnce(authError());
    await sm.sendMessage(sessionId, "hi");
    expect(sm.getReadiness("claude-code").state).toBe("needs-auth");
    expect(clearSignInConfirmation).toHaveBeenCalledWith("claude-code");

    // Live, the standby that replenishes after the rejection flipped needs-auth
    // back to ready 100–200 ms later. Drive that session/new here.
    const newSessionsBefore = mockConnection.newSession.mock.calls.length;
    await sm.createSession();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockConnection.newSession.mock.calls.length).toBeGreaterThan(newSessionsBefore);

    expect(sm.getReadiness("claude-code").state).toBe("needs-auth");
    expect(readinessEvents().map((e) => e.readiness.state)).toEqual(["ready", "needs-auth"]);
    // Only the wizard's POST sets a confirmation; the rejection cleared it exactly once.
    expect(clearSignInConfirmation).toHaveBeenCalledTimes(1);
  });

  it("a successful prompt turn is proof of readiness — it clears needs-auth", async () => {
    const sessionId = await claudeChat();
    mockConnection.prompt.mockRejectedValueOnce(authError());
    await sm.sendMessage(sessionId, "hi");
    expect(sm.getReadiness("claude-code").state).toBe("needs-auth");

    await sm.sendMessage(sessionId, "hi again"); // the default mock resolves { stopReason: "end_turn" }
    expect(sm.getReadiness("claude-code")).toEqual({ state: "ready" });
  });

  it("a CANCELLED turn proves nothing — needs-auth stays", async () => {
    const sessionId = await claudeChat();
    mockConnection.prompt.mockRejectedValueOnce(authError());
    await sm.sendMessage(sessionId, "hi");
    mockConnection.prompt.mockResolvedValueOnce({ stopReason: "cancelled" });
    await sm.sendMessage(sessionId, "hi again");
    expect(sm.getReadiness("claude-code").state).toBe("needs-auth");
  });

  it("claude-code: the expired-OAuth reply TEXT is an observed auth rejection — needs-auth, confirmation cleared, not undone by the turn's clean resolution", async () => {
    const sessionId = await claudeChat();
    sm.getEventHandler();
    const onAuthRejectedText = handlerCtorArgs.at(-1)?.[5] as ((id: string) => void) | undefined;
    expect(typeof onAuthRejectedText).toBe("function");

    mockConnection.prompt.mockImplementationOnce(async () => {
      onAuthRejectedText!(sessionId); // what the handler does when the turn opens with the prefix
      return { stopReason: "end_turn" };
    });
    await sm.sendMessage(sessionId, "hi");
    expect(sm.getReadiness("claude-code").state).toBe("needs-auth");
    expect(clearSignInConfirmation).toHaveBeenCalledWith("claude-code");
    // Claude rejects at the prompt, so its funnel event says so.
    expect(trackServerEvent.mock.calls.filter(([name]) => name === "agent_auth_rejected")).toEqual([
      ["agent_auth_rejected", { agent: "claude-code", stage: "prompt" }],
    ]);

    // The next turn that comes back clean is proof of readiness again.
    await sm.sendMessage(sessionId, "hi again");
    expect(sm.getReadiness("claude-code")).toEqual({ state: "ready" });
  });

  it("still records needs-auth, and warns, when clearing the confirmation throws", async () => {
    clearSignInConfirmation.mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    const warn = vi.spyOn(serverLogger, "warn");
    try {
      mockConnection.newSession.mockRejectedValue(authError());
      await sm.switchAgent("codex", { awaitStandbyMs: 2000 });

      expect(sm.getReadiness("codex").state).toBe("needs-auth");
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          tag: "session-manager",
          op: "clear_sign_in_confirmation_failed",
          agentId: "codex",
        }),
        expect.any(String),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("a NON-auth prompt failure neither clears the confirmation nor changes readiness", async () => {
    const sessionId = await claudeChat();
    expect(sm.getReadiness("claude-code")).toEqual({ state: "ready" });

    mockConnection.prompt.mockRejectedValueOnce(new Error("ECONNRESET"));
    await sm.sendMessage(sessionId, "hi");

    expect(sm.getReadiness("claude-code")).toEqual({ state: "ready" });
    expect(clearSignInConfirmation).not.toHaveBeenCalled();
    expect(readinessEvents().map((e) => e.readiness.state)).toEqual(["ready"]);
  });

  it("codex: a returned prompt turn records ready, with no session/new in between", async () => {
    await sm.switchAgent("codex", { awaitStandbyMs: 2000 });
    const sessionId = await sm.createSession();
    await new Promise((r) => setTimeout(r, 0));
    mockConnection.prompt.mockRejectedValueOnce(authError());
    await sm.sendMessage(sessionId, "hi");
    expect(sm.getReadiness("codex").state).toBe("needs-auth");

    const newSessionsBefore = mockConnection.newSession.mock.calls.length;
    await sm.sendMessage(sessionId, "hi again");

    expect(mockConnection.newSession.mock.calls.length).toBe(newSessionsBefore);
    expect(sm.getReadiness("codex")).toEqual({ state: "ready" });
  });

  // A prompt-observed needs-auth has no session/new that can undo it, so without
  // a way to forget it the user loops back to the sign-in terminal until libi
  // restarts. Two user actions supersede the old observation — confirming
  // sign-in, and picking the agent again — and both hand back `unknown`, never
  // `ready`. From there readiness is observed again: a clean standby
  // `session/new` records `ready`, and a prompt rejection records `needs-auth`.

  /** A claude-code chat whose prompt was just rejected for auth. */
  async function claudeRejectedAtPrompt(): Promise<string> {
    const sessionId = await claudeChat();
    mockConnection.prompt.mockRejectedValueOnce(authError());
    await sm.sendMessage(sessionId, "hi");
    expect(sm.getReadiness("claude-code").state).toBe("needs-auth");
    return sessionId;
  }

  it("confirming sign-in forgets an observed needs-auth: readiness becomes unknown, and is broadcast", async () => {
    await claudeRejectedAtPrompt();

    sm.forgetObservedAuthFailure("claude-code");

    expect(sm.getReadiness("claude-code")).toEqual({ state: "unknown" });
    const events = readinessEvents();
    expect(events.map((e) => e.readiness.state)).toEqual(["ready", "needs-auth", "unknown"]);
    expect(events.at(-1)?.agentId).toBe("claude-code");
  });

  it("after forgetting, the next clean standby session/new records ready, and a prompt rejection records needs-auth again", async () => {
    const sessionId = await claudeRejectedAtPrompt();
    sm.forgetObservedAuthFailure("claude-code");

    const newSessionsBefore = mockConnection.newSession.mock.calls.length;
    await sm.createSession();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockConnection.newSession.mock.calls.length).toBeGreaterThan(newSessionsBefore);
    expect(sm.getReadiness("claude-code")).toEqual({ state: "ready" });
    expect(readinessEvents().map((e) => e.readiness.state)).toEqual(["ready", "needs-auth", "unknown", "ready"]);

    mockConnection.prompt.mockRejectedValueOnce(authError());
    await sm.sendMessage(sessionId, "still signed out");
    expect(sm.getReadiness("claude-code").state).toBe("needs-auth");
  });

  it("claude-code: picking the agent again forgets a prompt-observed needs-auth before its session/new starts", async () => {
    await claudeRejectedAtPrompt();

    let readinessAtSessionNew: string | null = null;
    mockConnection.newSession.mockImplementationOnce(async () => {
      readinessAtSessionNew = sm.getReadiness("claude-code").state;
      return { sessionId: "s-reselected" };
    });
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });

    expect(readinessAtSessionNew).toBe("unknown");
    // The standby's clean session/new is the observation that follows.
    expect(sm.getReadiness("claude-code")).toEqual({ state: "ready" });
    expect(readinessEvents().map((e) => e.readiness.state)).toEqual(["ready", "needs-auth", "unknown", "ready"]);
  });

  it("codex: picking the agent again keeps needs-auth — its own session/new re-tests it", async () => {
    mockConnection.newSession.mockRejectedValue(authError());
    await sm.switchAgent("codex", { awaitStandbyMs: 2000 });
    expect(sm.getReadiness("codex").state).toBe("needs-auth");

    let readinessAtSessionNew: string | null = null;
    mockConnection.newSession.mockImplementationOnce(async () => {
      readinessAtSessionNew = sm.getReadiness("codex").state;
      throw authError();
    });
    await sm.switchAgent("codex", { awaitStandbyMs: 2000 });

    expect(readinessAtSessionNew).toBe("needs-auth");
    expect(sm.getReadiness("codex").state).toBe("needs-auth");
    expect(readinessEvents().map((e) => e.readiness.state)).toEqual(["needs-auth"]);
  });

  it("forgetting changes nothing for an agent that is not in needs-auth", async () => {
    sm.forgetObservedAuthFailure("codex"); // unknown
    expect(sm.getReadiness("codex")).toEqual({ state: "unknown" });

    await sm.switchAgent("codex", { awaitStandbyMs: 2000 });
    expect(sm.getReadiness("codex")).toEqual({ state: "ready" });
    sm.forgetObservedAuthFailure("codex"); // ready
    expect(sm.getReadiness("codex")).toEqual({ state: "ready" });

    expect(readinessEvents().map((e) => e.readiness.state)).toEqual(["ready"]);
  });

  it("forgetting ignores an agent the setup wizard does not walk through", async () => {
    mockConnection.newSession.mockRejectedValue(authError());
    await sm.switchAgent("some-other-agent", { awaitStandbyMs: 2000 });
    expect(sm.getReadiness("some-other-agent").state).toBe("needs-auth");

    sm.forgetObservedAuthFailure("some-other-agent");

    expect(sm.getReadiness("some-other-agent").state).toBe("needs-auth");
  });

  it("broadcasts the transition on the system channel", async () => {
    mockConnection.newSession.mockRejectedValue(authError());

    await sm.switchAgent("codex", { awaitStandbyMs: 2000 });

    const events = readinessEvents();
    expect(events).toHaveLength(1);
    expect(events[0].agentId).toBe("codex");
    expect(events[0].readiness.state).toBe("needs-auth");
  });

  it("records needs-auth when a fresh createSession() is rejected, and still throws", async () => {
    mockConnection.newSession.mockRejectedValue(authError());
    // Adopt the agent without letting the standby run, so createSession() is
    // the first session/new we observe.
    await sm.switchAgent("codex");
    sm.getReadiness("codex"); // (standby may or may not have landed yet)
    systemEvents.length = 0;

    await expect(sm.createSession()).rejects.toThrow(/Authentication required/);
    expect(sm.getReadiness("codex").state).toBe("needs-auth");
  });

  it("leaves readiness alone for a NON-auth failure — no invented diagnosis", async () => {
    mockConnection.newSession.mockRejectedValue(new Error("ECONNRESET"));

    await sm.switchAgent("codex", { awaitStandbyMs: 2000 });

    expect(sm.getReadiness("codex")).toEqual({ state: "unknown" });
    expect(readinessEvents()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // (b) success ⇒ ready
  // -------------------------------------------------------------------------

  it("records ready when session/new resolves", async () => {
    await sm.switchAgent("codex", { awaitStandbyMs: 2000 });

    expect(sm.getReadiness("codex")).toEqual({ state: "ready" });
    const events = readinessEvents();
    expect(events).toHaveLength(1);
    expect(events[0].readiness).toEqual({ state: "ready" });
  });

  it("does not re-broadcast an unchanged readiness", async () => {
    await sm.switchAgent("codex", { awaitStandbyMs: 2000 });
    await sm.createSession(); // claims the standby, replenishes → another ready
    await new Promise((r) => setTimeout(r, 0));

    expect(readinessEvents()).toHaveLength(1);
  });

  it("recovers to ready after a needs-auth once a session/new succeeds", async () => {
    mockConnection.newSession.mockRejectedValueOnce(authError());
    await sm.switchAgent("codex", { awaitStandbyMs: 2000 });
    expect(sm.getReadiness("codex").state).toBe("needs-auth");

    await sm.createSession();

    expect(sm.getReadiness("codex")).toEqual({ state: "ready" });
    expect(readinessEvents().map((e) => e.readiness.state)).toEqual([
      "needs-auth",
      "ready",
    ]);
  });

  it("returns the readiness from switchAgent so the caller can report it", async () => {
    mockConnection.newSession.mockRejectedValue(authError());
    const readiness = await sm.switchAgent("codex", { awaitStandbyMs: 2000 });
    expect(readiness.state).toBe("needs-auth");
  });

  // -------------------------------------------------------------------------
  // Ordering: the status dot must not go green before the process exists
  // -------------------------------------------------------------------------

  it("adopts the agent only AFTER warmProcess resolves", async () => {
    let activeDuringWarm: string | null = "sentinel";
    pm.warmProcess.mockImplementation(async () => {
      activeDuringWarm = sm.activeAgentId;
    });

    await sm.switchAgent("codex");

    expect(activeDuringWarm).toBeNull();
    expect(sm.activeAgentId).toBe("codex");
  });

  it("does not adopt an agent whose process never came up", async () => {
    pm.warmProcess.mockRejectedValue(new Error("spawn ENOENT"));

    await expect(sm.switchAgent("codex")).rejects.toThrow(/spawn ENOENT/);

    expect(sm.activeAgentId).toBeNull();
  });

  it("a spawn REFUSED for a missing/outdated CLI sets readiness not-installed with the Agents reason", async () => {
    // The error the process manager really throws, not a look-alike message.
    const refusal = new AgentSpawnRefusedError("codex", {
      code: "not_installed",
      message: "Codex 1.0.0 is older than libi needs — open Agents to update it.",
      detail: "below minimum",
    });
    pm.warmProcess.mockRejectedValue(refusal);
    await expect(sm.switchAgent("codex")).rejects.toBe(refusal);
    expect(sm.getReadiness("codex")).toEqual({
      state: "not-installed",
      reason: "Codex 1.0.0 is older than libi needs — open Agents to update it.",
    });
    expect(sm.activeAgentId).toBeNull();
  });

  /** The error the process manager throws when the CLI is below the minimum. */
  function belowMinimumRefusal(): AgentSpawnRefusedError {
    return new AgentSpawnRefusedError("claude-code", {
      code: "not_installed",
      message: "Claude Code 2.0.1 is older than libi needs — open Agents to update it.",
      detail: "below minimum",
    });
  }

  it("a new chat with no standby and no process: a REFUSED spawn records not-installed and is rethrown", async () => {
    mockConnection.newSession.mockRejectedValueOnce(new Error("standby failed for another reason"));
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    expect(sm.isStandbyReady()).toBe(false);
    pm.getConnection.mockReturnValue(null); // the process is gone
    const refusal = belowMinimumRefusal();
    pm.warmProcess.mockRejectedValueOnce(refusal);

    await expect(sm.createSession()).rejects.toBe(refusal);
    expect(sm.getReadiness("claude-code")).toEqual({ state: "not-installed", reason: refusal.reason.message });
  });

  it("a resume with no process warms the agent; a REFUSED spawn records not-installed and the resume fails", async () => {
    pm.getCapabilitiesForAgent.mockReturnValue({ canListSessions: true });
    mockConnection.listSessions.mockResolvedValueOnce({
      sessions: [{ sessionId: "old-1", title: "Old", updatedAt: null }],
      nextCursor: null,
    });
    await sm.switchAgent("claude-code", { awaitStandbyMs: 2000 });
    pm.getConnection.mockReturnValue(null); // the process is gone
    const refusal = belowMinimumRefusal();
    pm.warmProcess.mockRejectedValueOnce(refusal);

    await expect(sm.activateSession("old-1")).rejects.toBe(refusal);
    expect(pm.warmProcess).toHaveBeenCalledTimes(2); // the switch, then this resume
    expect(sm.getReadiness("claude-code")).toEqual({ state: "not-installed", reason: refusal.reason.message });
    expect(mockConnection.loadSession).not.toHaveBeenCalled();
  });

  it("a plain spawn error that merely READS like a refusal leaves readiness alone — the type decides, not the text", async () => {
    pm.warmProcess.mockRejectedValue(new Error("Agent codex is not installed: something else entirely"));
    await expect(sm.switchAgent("codex")).rejects.toThrow(/not installed/);
    expect(sm.getReadiness("codex")).toEqual({ state: "unknown" });
  });

  it("a session/new error whose message contains 'is not installed: ' never sets not-installed — session/new cannot refuse a spawn", async () => {
    mockConnection.newSession.mockRejectedValue(new Error("MCP server foo is not installed: run the installer"));
    await sm.switchAgent("codex", { awaitStandbyMs: 2000 });
    expect(sm.getReadiness("codex")).toEqual({ state: "unknown" });

    // No standby survived, so this is the fresh-create path.
    await expect(sm.createSession()).rejects.toThrow(/is not installed: /);
    expect(sm.getReadiness("codex")).toEqual({ state: "unknown" });
    expect(readinessEvents()).toHaveLength(0);
  });

  it("any other spawn failure leaves readiness alone (no invented diagnosis)", async () => {
    pm.warmProcess.mockRejectedValue(new Error("spawn ENOENT"));
    await expect(sm.switchAgent("codex")).rejects.toThrow(/spawn ENOENT/);
    expect(sm.getReadiness("codex")).toEqual({ state: "unknown" });
  });
});

/**
 * `listSessions` is the FIRST call that touches credentials for an agent that
 * advertises `canListSessions` — and codex advertises it as TRUE.
 *
 * It was uncaught, so an unauthenticated user's `-32000` propagated out of
 * `switchAgent`, out of `POST /api/agent/start` as a 500, and out of
 * `selectAgent` (which rethrows every non-OK response) as a full-page Next
 * error overlay reading "Authentication required". A crash standing in for an
 * ordinary, expected state — and strictly worse than the silent failure it
 * replaced, because the app now looked broken.
 *
 * Reported live after the first fix landed; no unit test covered it because
 * every existing case mocked `canListSessions: false`.
 */
describe("SessionManager — a failure to list past sessions never crashes the switch", () => {
  let sm: SessionManager;
  let pm: ReturnType<typeof createMockPm>["pm"];
  let mockConnection: ReturnType<typeof createMockPm>["mockConnection"];

  beforeEach(() => {
    vi.clearAllMocks();
    // canListSessions: TRUE — codex's real advertised capability, and the
    // branch none of the other tests in this file exercise.
    const mocks = createMockPm({ canListSessions: true });
    pm = mocks.pm;
    mockConnection = mocks.mockConnection;
    sm = new SessionManager();
    sm.setProcessManager(pm);
  });

  it("resolves instead of rejecting when listSessions is refused for auth", async () => {
    mockConnection.listSessions.mockRejectedValue(authError());

    // The assertion IS that this does not throw.
    const readiness = await sm.switchAgent("codex", { awaitStandbyMs: 0 });

    expect(readiness.state).toBe("needs-auth");
  });

  it("still adopts the agent, so the user can act on the sign-in prompt", async () => {
    mockConnection.listSessions.mockRejectedValue(authError());
    await sm.switchAgent("codex", { awaitStandbyMs: 0 });
    expect(sm.activeAgentId).toBe("codex");
  });

  it("survives a non-auth listing failure too, without inventing a diagnosis", async () => {
    mockConnection.listSessions.mockRejectedValue(new Error("stream closed"));

    const readiness = await sm.switchAgent("codex", { awaitStandbyMs: 0 });

    // Not signed-in — we have no evidence of that. Being unable to list HISTORY
    // never means the agent is unusable for a NEW chat.
    expect(readiness.state).not.toBe("needs-auth");
    expect(sm.activeAgentId).toBe("codex");
  });
});
