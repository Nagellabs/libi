// __tests__/integration/session-manager-cancel.test.ts
//
// Verifies that SessionManager.cancelTurn() sends ACP session/cancel without
// tearing down the session connection or changing the session's active state.
//
// Approach: lightweight unit test — we construct a SessionManager directly,
// manually populate the internal `sessions` Map with a fake SessionEntry, and
// stub `pm.getConnection` to return a fake connection object with a vi.fn()
// cancel method. This avoids the heavy ACP/Next.js/DB bootstrap that a full
// integration test would require.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionManager } from "@/lib/sessions/session-manager";
import type { SessionEntry } from "@/lib/sessions/types";
import type { ClientSideConnection } from "@agentclientprotocol/sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  sessionId: string,
  agentId: string,
  active: boolean,
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
  };
}

/** Build a minimal stub ProcessManager and inject it into the SessionManager. */
function makeStubPm(cancelFn: ReturnType<typeof vi.fn>) {
  return {
    getConnection: vi.fn((_agentId: string): ClientSideConnection | null => {
      return {
        cancel: cancelFn,
      } as unknown as ClientSideConnection;
    }),
    warmProcess: vi.fn(async () => {}),
    getCapabilitiesForAgent: vi.fn(() => ({ canListSessions: true })),
    registerSessionId: vi.fn(),
    unregisterSessionId: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionManager.cancelTurn", () => {
  let sm: SessionManager;
  let cancelFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sm = new SessionManager();
    cancelFn = vi.fn().mockResolvedValue(undefined);
    const pm = makeStubPm(cancelFn);
    sm.setProcessManager(pm);
  });

  it("sends ACP session/cancel for an active session", async () => {
    const sessionId = "sess-abc123";
    const entry = makeEntry(sessionId, "claude", true);

    // Directly inject the entry into the internal Map via the public accessor
    // trick: getSession returns from the private map, so we need a backdoor.
    // We cast to access the private field for testing purposes only.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).sessions.set(sessionId, entry);
    // Also set active agent so pm.getConnection is called with the right id
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any)._activeAgentId = "claude";

    await sm.cancelTurn(sessionId);

    expect(cancelFn).toHaveBeenCalledTimes(1);
    expect(cancelFn).toHaveBeenCalledWith({ sessionId });
  });

  it("leaves session active after cancel (no teardown)", async () => {
    const sessionId = "sess-active";
    const entry = makeEntry(sessionId, "claude", true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).sessions.set(sessionId, entry);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any)._activeAgentId = "claude";

    await sm.cancelTurn(sessionId);

    // Session must remain active and cache/listeners must be untouched
    const after = sm.getSession(sessionId);
    expect(after?.active).toBe(true);
    expect(after?.messageCache).toHaveLength(0); // cache was empty, still empty
  });

  it("is a no-op for an inactive session (cancel not called)", async () => {
    const sessionId = "sess-inactive";
    const entry = makeEntry(sessionId, "claude", false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).sessions.set(sessionId, entry);

    await sm.cancelTurn(sessionId);

    expect(cancelFn).not.toHaveBeenCalled();
    // Session remains inactive
    expect(sm.getSession(sessionId)?.active).toBe(false);
  });

  it("is a no-op for an unknown sessionId", async () => {
    await sm.cancelTurn("nonexistent-session");
    expect(cancelFn).not.toHaveBeenCalled();
  });

  it("is a no-op when no pm is set", async () => {
    // Create a fresh SM with NO process manager
    const freshSm = new SessionManager();
    const sessionId = "sess-no-pm";
    const entry = makeEntry(sessionId, "claude", true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (freshSm as any).sessions.set(sessionId, entry);

    // Should not throw
    await expect(freshSm.cancelTurn(sessionId)).resolves.toBeUndefined();
    expect(cancelFn).not.toHaveBeenCalled();
  });

  it("swallows errors from conn.cancel without throwing", async () => {
    const badCancel = vi.fn().mockRejectedValue(new Error("network error"));
    const pm = makeStubPm(badCancel);
    sm.setProcessManager(pm);

    const sessionId = "sess-error";
    const entry = makeEntry(sessionId, "claude", true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).sessions.set(sessionId, entry);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any)._activeAgentId = "claude";

    // Must not throw even if cancel rejects
    await expect(sm.cancelTurn(sessionId)).resolves.toBeUndefined();
    expect(badCancel).toHaveBeenCalledTimes(1);
    // Session still active
    expect(sm.getSession(sessionId)?.active).toBe(true);
  });
});
