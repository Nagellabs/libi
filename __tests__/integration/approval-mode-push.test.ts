// __tests__/integration/approval-mode-push.test.ts
//
// Verifies that SessionManager pushes the saved approval mode to ACP via
// `session/set_mode` after newSession, and on user-driven mode changes
// through `applyApprovalModeToActiveSessions`. Mapping is PER-AGENT
// (`lib/sessions/approval-mode-map.ts#acpModeFor`):
//   claude-code:  ask → "default",  auto / auto-with-generations → "bypassPermissions"
//   codex:        ask → "auto",     auto / auto-with-generations → "full-access"
//
// Behaviour matrix (the post-Task-4.3 contract — the -32602 fix):
//   - `setSessionMode` is ONLY called with a mode id the agent actually
//     advertised. The advertised set comes from the `availableModes` param
//     (fresh newSession/standby response) or, when that is undefined, from
//     the set CACHED on the SessionEntry at newSession/standby time.
//   - NEVER pushes blind: when neither the param nor the cache advertises the
//     mapped id (or the agent is unmapped), the push is SKIPPED with a
//     `approval.mode.unsupported_by_agent` warn — no `setSessionMode` call.
//   - Catches and logs `setSessionMode` rejections (never propagates).
//   - `applyApprovalModeToActiveSessions(agentId)` only pushes for active
//     sessions belonging to that agent, reading each entry's cached modes.
//
// Mocks the approval-settings reader so tests don't touch the real settings
// DB. Uses a stubbed ProcessManager — the real ACP client is not exercised
// here; we just verify SessionManager's bridging logic against its connection
// surface.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/approval/settings", () => ({
  getApprovalMode: vi.fn(),
}));

// No saved model preference — pushModelToSession no-ops (mirrors the approval mock;
// avoids the settings DB these standby-claim/reactivation paths would otherwise hit).
vi.mock("@/lib/sessions/model-preferences", () => ({
  getAgentModelId: vi.fn(() => null),
  setAgentModelId: vi.fn(),
}));

vi.mock("@/lib/mcp-config", () => ({
  getMcpServersForAcp: vi.fn(() => []),
  onMcpConfigInvalidated: vi.fn(),
}));

import { getApprovalMode } from "@/lib/approval/settings";
import { serverLogger } from "@/lib/logger";
import { SessionManager } from "@/lib/sessions/session-manager";
import type { SessionEntry } from "@/lib/sessions/types";
import type { ApprovalMode } from "@/lib/approval/mode";
import type { ClientSideConnection } from "@agentclientprotocol/sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The real ACP `availableModes` shapes each adapter advertises. */
const CLAUDE_MODES = [
  { id: "default" },
  { id: "acceptEdits" },
  { id: "bypassPermissions" },
];
const CODEX_MODES = [{ id: "read-only" }, { id: "auto" }, { id: "full-access" }];

function makeEntry(
  sessionId: string,
  agentId: string,
  active: boolean,
  availableModes?: { id: string }[],
): SessionEntry {
  return {
    sessionId,
    agentId,
    title: null,
    updatedAt: null,
    active,
    lastUsed: Date.now(),
    messageCache: [],
    currentAgentMessage: null,
    currentUserMessage: null,
    listeners: new Set(),
    pendingApprovals: new Map(),
    configOptions: [],
    latestUsage: null,
    availableCommands: [],
    availableModes,
  };
}

function makeStubPm(setSessionMode: ReturnType<typeof vi.fn>) {
  return {
    getConnection: vi.fn(
      (_agentId: string): ClientSideConnection | null =>
        ({
          setSessionMode,
          cancel: vi.fn().mockResolvedValue(undefined),
          closeSession: vi.fn().mockResolvedValue(undefined),
        }) as unknown as ClientSideConnection,
    ),
    warmProcess: vi.fn(async () => {}),
    getCapabilitiesForAgent: vi.fn(() => ({ canListSessions: true })),
    registerSessionId: vi.fn(),
    unregisterSessionId: vi.fn(),
  };
}

/** Cast to `any` to invoke the private `pushApprovalModeToSession` helper.
 *  Keeps the production class surface clean while still testing the unit. */
function callPush(
  sm: SessionManager,
  sessionId: string,
  agentId: string,
  availableModes: { id: string }[] | undefined,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (sm as any).pushApprovalModeToSession(
    sessionId,
    agentId,
    availableModes,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionManager — approval mode → ACP setSessionMode push", () => {
  let sm: SessionManager;
  let setSessionMode: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    warnSpy = vi.spyOn(serverLogger, "warn").mockImplementation(() => {});
    setSessionMode = vi.fn().mockResolvedValue(undefined);
    sm = new SessionManager();
    sm.setProcessManager(makeStubPm(setSessionMode));
  });

  describe("per-agent mode mapping (claude-code vocabulary)", () => {
    it.each<[ApprovalMode, string]>([
      ["ask", "default"],
      ["auto", "bypassPermissions"],
      ["auto-with-generations", "bypassPermissions"],
    ])("maps %s → %s when advertised", async (mode, expectedAcpMode) => {
      vi.mocked(getApprovalMode).mockReturnValue(mode);

      await callPush(sm, "s1", "claude-code", CLAUDE_MODES);

      expect(setSessionMode).toHaveBeenCalledTimes(1);
      expect(setSessionMode).toHaveBeenCalledWith({
        sessionId: "s1",
        modeId: expectedAcpMode,
      });
    });
  });

  describe("per-agent mode mapping (codex vocabulary)", () => {
    it.each<[ApprovalMode, string]>([
      ["ask", "auto"],
      ["auto", "full-access"],
      ["auto-with-generations", "full-access"],
    ])("maps %s → %s when advertised", async (mode, expectedAcpMode) => {
      vi.mocked(getApprovalMode).mockReturnValue(mode);

      await callPush(sm, "x1", "codex", CODEX_MODES);

      expect(setSessionMode).toHaveBeenCalledTimes(1);
      expect(setSessionMode).toHaveBeenCalledWith({
        sessionId: "x1",
        modeId: expectedAcpMode,
      });
    });
  });

  it("skips the call (logs warn) when target mode is NOT in availableModes", async () => {
    vi.mocked(getApprovalMode).mockReturnValue("auto");

    // Codex only advertises read-only — full-access isn't supported.
    await callPush(sm, "s1", "codex", [{ id: "read-only" }]);

    expect(setSessionMode).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "codex", mode: "auto" }),
      "approval.mode.unsupported_by_agent",
    );
  });

  it("skips the call for an agent with no known mode vocabulary", async () => {
    vi.mocked(getApprovalMode).mockReturnValue("auto");

    // Unknown agent — even a fully-advertised set can't be mapped.
    await callPush(sm, "s1", "gemini", CLAUDE_MODES);

    expect(setSessionMode).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "gemini" }),
      "approval.mode.unsupported_by_agent",
    );
  });

  it("calls setSessionMode when target mode IS advertised", async () => {
    vi.mocked(getApprovalMode).mockReturnValue("auto");

    await callPush(sm, "s1", "claude-code", CLAUDE_MODES);

    expect(setSessionMode).toHaveBeenCalledTimes(1);
    expect(setSessionMode).toHaveBeenCalledWith({
      sessionId: "s1",
      modeId: "bypassPermissions",
    });
  });

  it("falls back to the CACHED availableModes when the param is undefined (never pushes blind)", async () => {
    vi.mocked(getApprovalMode).mockReturnValue("auto");

    // The entry cached its advertised set at newSession/standby time.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessionMap: Map<string, SessionEntry> = (sm as any).sessions;
    sessionMap.set(
      "cached-1",
      makeEntry("cached-1", "claude-code", true, CLAUDE_MODES),
    );

    await callPush(sm, "cached-1", "claude-code", undefined);

    expect(setSessionMode).toHaveBeenCalledTimes(1);
    expect(setSessionMode).toHaveBeenCalledWith({
      sessionId: "cached-1",
      modeId: "bypassPermissions",
    });
  });

  it("skips (does NOT push blind) when neither the param nor the cache advertises modes", async () => {
    vi.mocked(getApprovalMode).mockReturnValue("auto");

    // No session entry exists → no cached modes; param is undefined.
    await callPush(sm, "unknown-session", "claude-code", undefined);

    expect(setSessionMode).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "claude-code", mode: "auto" }),
      "approval.mode.unsupported_by_agent",
    );
  });

  it("catches setSessionMode rejections (does not propagate)", async () => {
    vi.mocked(getApprovalMode).mockReturnValue("auto");
    setSessionMode.mockRejectedValueOnce(new Error("agent rejected"));

    // Must not throw.
    await expect(
      callPush(sm, "s1", "claude-code", CLAUDE_MODES),
    ).resolves.toBeUndefined();
  });

  it("no-ops when there's no connection for the agent", async () => {
    vi.mocked(getApprovalMode).mockReturnValue("auto");

    // Replace pm.getConnection to return null for this agent. The mode is
    // fully advertised, so the ONLY reason to skip is the missing connection.
    sm.setProcessManager({
      ...makeStubPm(setSessionMode),
      getConnection: vi.fn(() => null),
    });

    await callPush(sm, "s1", "claude-code", CLAUDE_MODES);

    expect(setSessionMode).not.toHaveBeenCalled();
  });
});

describe("SessionManager.applyApprovalModeToActiveSessions", () => {
  let sm: SessionManager;
  let setSessionMode: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(serverLogger, "warn").mockImplementation(() => {});
    vi.mocked(getApprovalMode).mockReturnValue("auto");
    setSessionMode = vi.fn().mockResolvedValue(undefined);
    sm = new SessionManager();
    sm.setProcessManager(makeStubPm(setSessionMode));
  });

  it("pushes only to active sessions belonging to the requested agent, using each agent's vocabulary", async () => {
    const claudeActive = makeEntry(
      "c-active",
      "claude-code",
      true,
      CLAUDE_MODES,
    );
    const claudeInactive = makeEntry(
      "c-inactive",
      "claude-code",
      false,
      CLAUDE_MODES,
    );
    const codexActive = makeEntry("x-active", "codex", true, CODEX_MODES);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessionMap: Map<string, SessionEntry> = (sm as any).sessions;
    sessionMap.set(claudeActive.sessionId, claudeActive);
    sessionMap.set(claudeInactive.sessionId, claudeInactive);
    sessionMap.set(codexActive.sessionId, codexActive);

    await sm.applyApprovalModeToActiveSessions("claude-code");

    // Only the one active claude session got the push, with claude's id.
    expect(setSessionMode).toHaveBeenCalledTimes(1);
    expect(setSessionMode).toHaveBeenCalledWith({
      sessionId: "c-active",
      modeId: "bypassPermissions",
    });

    // The codex broadcast pushes codex's OWN mapped id — never claude's.
    await sm.applyApprovalModeToActiveSessions("codex");

    expect(setSessionMode).toHaveBeenCalledTimes(2);
    expect(setSessionMode).toHaveBeenLastCalledWith({
      sessionId: "x-active",
      modeId: "full-access",
    });
  });

  it("is a no-op when no active sessions match the agent", async () => {
    const claudeInactive = makeEntry(
      "c-inactive",
      "claude-code",
      false,
      CLAUDE_MODES,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessionMap: Map<string, SessionEntry> = (sm as any).sessions;
    sessionMap.set(claudeInactive.sessionId, claudeInactive);

    await sm.applyApprovalModeToActiveSessions("claude-code");

    expect(setSessionMode).not.toHaveBeenCalled();
  });

  it("pushes to all active sessions in parallel (broadcast invokes setSessionMode N times)", async () => {
    const a = makeEntry("a", "claude-code", true, CLAUDE_MODES);
    const b = makeEntry("b", "claude-code", true, CLAUDE_MODES);
    const c = makeEntry("c", "claude-code", true, CLAUDE_MODES);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessionMap: Map<string, SessionEntry> = (sm as any).sessions;
    sessionMap.set(a.sessionId, a);
    sessionMap.set(b.sessionId, b);
    sessionMap.set(c.sessionId, c);

    // Make each call resolve only when explicitly released, so we can prove
    // they were dispatched concurrently rather than sequentially.
    const releases: Array<() => void> = [];
    setSessionMode.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );

    const broadcast = sm.applyApprovalModeToActiveSessions("claude-code");

    // All three calls should have been dispatched immediately, before any
    // resolves — that's what "parallel" means here.
    await Promise.resolve();
    expect(setSessionMode).toHaveBeenCalledTimes(3);
    expect(releases).toHaveLength(3);

    // Release them and let the broadcast settle.
    for (const release of releases) release();
    await broadcast;

    // Sanity-check each session got exactly one push with the expected mode.
    const calls = setSessionMode.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(
      expect.arrayContaining([
        { sessionId: "a", modeId: "bypassPermissions" },
        { sessionId: "b", modeId: "bypassPermissions" },
        { sessionId: "c", modeId: "bypassPermissions" },
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Standby-claim and reactivation push paths
// ---------------------------------------------------------------------------

describe("SessionManager — push on standby-claim and reactivation", () => {
  let sm: SessionManager;
  let setSessionMode: ReturnType<typeof vi.fn>;
  let newSession: ReturnType<typeof vi.fn>;
  let loadSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(serverLogger, "warn").mockImplementation(() => {});
    vi.mocked(getApprovalMode).mockReturnValue("auto");

    setSessionMode = vi.fn().mockResolvedValue(undefined);
    newSession = vi.fn().mockResolvedValue({
      sessionId: "new-after-claim",
      modes: { availableModes: CLAUDE_MODES },
    });
    loadSession = vi.fn().mockResolvedValue(undefined);

    sm = new SessionManager();
    sm.setProcessManager({
      getConnection: vi.fn(
        (_agentId: string): ClientSideConnection | null =>
          ({
            setSessionMode,
            newSession,
            loadSession,
            cancel: vi.fn().mockResolvedValue(undefined),
            closeSession: vi.fn().mockResolvedValue(undefined),
          }) as unknown as ClientSideConnection,
      ),
      warmProcess: vi.fn(async () => {}),
      getCapabilitiesForAgent: vi.fn(() => ({ canListSessions: true })),
      registerSessionId: vi.fn(),
      unregisterSessionId: vi.fn(),
    });
  });

  it("pushes setSessionMode when claiming a pre-warmed standby (advertised modes captured at standby creation)", async () => {
    // Plant an active agent + a ready standby that ADVERTISED its modes when
    // it was created — the claim path hands them to the entry and gates the
    // push on them.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any)._activeAgentId = "claude-code";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).standbySession = {
      agentId: "claude-code",
      sessionId: "standby-1",
      configOptions: [],
      availableCommands: [],
      availableModes: CLAUDE_MODES,
    };

    const sessionId = await sm.createSession();

    expect(sessionId).toBe("standby-1");
    // The claim push resolves against the standby's advertised set.
    const calls = setSessionMode.mock.calls.map((c) => c[0]);
    expect(calls).toContainEqual({
      sessionId: "standby-1",
      modeId: "bypassPermissions",
    });

    // The advertised set was carried onto the claimed entry (later broadcasts
    // and reactivations gate on it).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (sm as any).sessions.get("standby-1") as SessionEntry;
    expect(entry.availableModes).toEqual(CLAUDE_MODES);
  });

  it("pushes setSessionMode after loadSession on reactivation, reading the CACHED modes", async () => {
    // Plant an inactive session entry (with modes cached at its original
    // newSession) that will be reactivated. loadSession does not re-advertise
    // modes — the push must resolve against the cache.
    const inactive = makeEntry("loaded-1", "claude-code", false, CLAUDE_MODES);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessionMap: Map<string, SessionEntry> = (sm as any).sessions;
    sessionMap.set(inactive.sessionId, inactive);

    await sm.activateSession("loaded-1");

    expect(loadSession).toHaveBeenCalledTimes(1);
    expect(setSessionMode).toHaveBeenCalledWith({
      sessionId: "loaded-1",
      modeId: "bypassPermissions",
    });

    // And the entry is now active (sanity check that activation finished).
    expect(sessionMap.get("loaded-1")?.active).toBe(true);
  });
});
