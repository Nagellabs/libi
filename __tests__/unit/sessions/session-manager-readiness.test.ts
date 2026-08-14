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
  // `getAgentInstallRoot()` (reached via the claude sign-in remedy) joins onto
  // this; the rest are required by lib/logger, imported transitively.
  getLibiHome: vi.fn(() => "/tmp/libi-test-home"),
  ensureLibiDirs: vi.fn(),
  getLibiLogDir: vi.fn(() => "/tmp/libi-test-logs"),
}));

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

vi.mock("@/lib/agents/session-event-handler", () => ({
  SessionEventHandler: vi.fn().mockImplementation(() => ({
    createClient: vi.fn().mockReturnValue({}),
    cleanUserMessageParts: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------

import { SessionManager, signInRemedyFor } from "@/lib/sessions/session-manager";

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
});

describe("signInRemedyFor", () => {
  it("offers Claude Code its own sign-in flow", () => {
    const remedy = signInRemedyFor("claude-code");
    expect(remedy).not.toBeNull();
    expect(remedy?.label).toMatch(/sign in/i);
    // Never `npm i -g` — the point of the remedy module is that signing in
    // does not require an install.
    expect(remedy?.command).not.toMatch(/npm/);
  });

  it("returns null for an agent it knows no remedy for", () => {
    expect(signInRemedyFor("terminal")).toBeNull();
  });

  it("offers codex a `login` on a bundled engine, or nothing at all", () => {
    // Environment-dependent: the bundled ~271MB engine may be absent in a
    // --omit=optional checkout, in which case null is the honest answer.
    const remedy = signInRemedyFor("codex");
    if (remedy) {
      expect(remedy.command).toMatch(/ login$/);
      expect(remedy.command).not.toMatch(/npm/);
    } else {
      expect(remedy).toBeNull();
    }
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
