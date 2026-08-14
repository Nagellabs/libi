// __tests__/integration/permission-cancel.test.ts
//
// Verifies the ACP spec invariant: every pending permission request resolves
// as `{ outcome: "cancelled" }` when the session is cancelled, evicted, or
// the agent process dies. Each path is exercised against the real
// `SessionManager` with a stubbed ProcessManager.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionManager } from "@/lib/sessions/session-manager";
import type { SessionEntry, PendingApproval } from "@/lib/sessions/types";
import type { AgentEvent } from "@/lib/agents/types";
import type {
  ClientSideConnection,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

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

/** Add `count` pending approvals to `entry` and return the array of promises
 *  representing the not-yet-settled `requestPermission` calls. */
function seedPending(
  entry: SessionEntry,
  count: number,
): Promise<RequestPermissionResponse>[] {
  const promises: Promise<RequestPermissionResponse>[] = [];
  for (let i = 0; i < count; i++) {
    const pendingId = `pend-${i}`;
    const promise = new Promise<RequestPermissionResponse>((resolve) => {
      const pending: PendingApproval = {
        pendingId,
        toolCall: { toolCallId: `t-${i}`, title: "Edit" },
        options: [],
        resolve,
        createdAt: Date.now(),
      };
      entry.pendingApprovals.set(pendingId, pending);
    });
    promises.push(promise);
  }
  return promises;
}

function makeStubPm(cancelFn?: ReturnType<typeof vi.fn>) {
  const cancel = cancelFn ?? vi.fn().mockResolvedValue(undefined);
  return {
    pm: {
      getConnection: vi.fn(
        (_agentId: string): ClientSideConnection | null =>
          ({
            cancel,
            closeSession: vi.fn().mockResolvedValue(undefined),
          }) as unknown as ClientSideConnection,
      ),
      warmProcess: vi.fn(async () => {}),
      getCapabilitiesForAgent: vi.fn(() => ({ canListSessions: true })),
      registerSessionId: vi.fn(),
      unregisterSessionId: vi.fn(),
    },
    cancel,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionManager — pending approvals cancellation invariant", () => {
  let sm: SessionManager;
  let resolvedEvents: Array<{ sessionId: string; event: AgentEvent }>;

  beforeEach(() => {
    sm = new SessionManager();
    sm.setProcessManager(makeStubPm().pm);
    resolvedEvents = [];
    sm.onGlobalEvent((sessionId, event) => {
      if (event.type === "agent-permission-resolved") {
        resolvedEvents.push({ sessionId, event });
      }
    });
  });

  it("cancelTurn drains pending approvals as cancelled and emits resolved events", async () => {
    const sessionId = "sess-cancel";
    const entry = makeEntry(sessionId, "claude", true);
    const promises = seedPending(entry, 3);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).sessions.set(sessionId, entry);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any)._activeAgentId = "claude";

    await sm.cancelTurn(sessionId);

    const results = await Promise.all(promises);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r).toEqual({ outcome: { outcome: "cancelled" } });
    }
    expect(entry.pendingApprovals.size).toBe(0);

    // One resolved event per drained pending.
    expect(resolvedEvents).toHaveLength(3);
    for (const { sessionId: sid, event } of resolvedEvents) {
      expect(sid).toBe(sessionId);
      if (event.type !== "agent-permission-resolved") {
        throw new Error("unexpected event type");
      }
      expect(event.outcome).toEqual({ kind: "cancelled" });
    }
  });

  it("cancelTurn drains approvals that arrive DURING the ACP cancel round-trip (race)", async () => {
    const sessionId = "sess-race";
    const entry = makeEntry(sessionId, "claude", true);
    const initialPromises = seedPending(entry, 1);

    // Build a controllable cancel — it returns a promise we resolve manually,
    // letting us inject a new pending approval mid-await. This reproduces the
    // race the post-drain in `finally` is meant to fix.
    let resolveCancel!: () => void;
    const cancelPromise = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });
    const cancelFn = vi.fn(() => cancelPromise);
    const stub = makeStubPm(cancelFn);

    const lateEntryPromises: Promise<RequestPermissionResponse>[] = [];

    sm = new SessionManager();
    sm.setProcessManager(stub.pm);
    resolvedEvents = [];
    sm.onGlobalEvent((sid, event) => {
      if (event.type === "agent-permission-resolved") {
        resolvedEvents.push({ sessionId: sid, event });
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).sessions.set(sessionId, entry);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any)._activeAgentId = "claude";

    // Kick off cancelTurn. It will pre-drain, then await our cancelPromise.
    const cancelTurnPromise = sm.cancelTurn(sessionId);

    // Yield so cancelTurn reaches the await on conn.cancel.
    await Promise.resolve();
    await Promise.resolve();

    // Confirm pre-drain happened — initial pending was resolved.
    expect(entry.pendingApprovals.size).toBe(0);

    // Simulate a NEW requestPermission landing while cancel is in flight.
    // This is the case the post-drain must catch.
    const lateId = "pend-late";
    const latePromise = new Promise<RequestPermissionResponse>((resolve) => {
      const pending: PendingApproval = {
        pendingId: lateId,
        toolCall: { toolCallId: "t-late", title: "Edit" },
        options: [],
        resolve,
        createdAt: Date.now(),
      };
      entry.pendingApprovals.set(lateId, pending);
    });
    lateEntryPromises.push(latePromise);

    // Now release the ACP cancel — cancelTurn proceeds to its `finally` block.
    resolveCancel();
    await cancelTurnPromise;

    // Both the original AND the late-arriving pending must have resolved
    // as cancelled, and the map must be empty.
    const initialResults = await Promise.all(initialPromises);
    const lateResults = await Promise.all(lateEntryPromises);

    expect(initialResults[0]).toEqual({ outcome: { outcome: "cancelled" } });
    expect(lateResults[0]).toEqual({ outcome: { outcome: "cancelled" } });
    expect(entry.pendingApprovals.size).toBe(0);

    // 1 from pre-drain (initial) + 1 from post-drain (late) = 2 events.
    expect(resolvedEvents).toHaveLength(2);
    expect(resolvedEvents.every((e) => e.sessionId === sessionId)).toBe(true);
  });

  it("deactivateSession drains pending approvals (LRU eviction path)", async () => {
    const sessionId = "sess-evict";
    const entry = makeEntry(sessionId, "claude", true);
    const promises = seedPending(entry, 2);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).sessions.set(sessionId, entry);

    await sm.deactivateSession(sessionId);

    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r).toEqual({ outcome: { outcome: "cancelled" } });
    }
    expect(entry.pendingApprovals.size).toBe(0);
    expect(resolvedEvents).toHaveLength(2);
  });

  it("handleProcessCrash drains pending approvals for sessions of the crashed agent", async () => {
    const sessionId = "sess-crash";
    const entry = makeEntry(sessionId, "claude", true);
    const promises = seedPending(entry, 2);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).sessions.set(sessionId, entry);

    sm.handleProcessCrash("claude", "agent died");

    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r).toEqual({ outcome: { outcome: "cancelled" } });
    }
    expect(entry.pendingApprovals.size).toBe(0);
    expect(resolvedEvents).toHaveLength(2);
  });

  it("does not touch pending approvals on a different agent during process crash", async () => {
    const sessionA = "sess-a";
    const sessionB = "sess-b";
    const entryA = makeEntry(sessionA, "claude", true);
    const entryB = makeEntry(sessionB, "codex", true);
    const promisesA = seedPending(entryA, 1);
    seedPending(entryB, 1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).sessions.set(sessionA, entryA);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).sessions.set(sessionB, entryB);

    sm.handleProcessCrash("claude", "claude died");

    // Claude's pending must drain.
    const resultsA = await Promise.all(promisesA);
    expect(resultsA[0]).toEqual({ outcome: { outcome: "cancelled" } });

    // Codex's pending must remain untouched.
    expect(entryB.pendingApprovals.size).toBe(1);
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0]?.sessionId).toBe(sessionA);
  });

  it("resetAll drains pending approvals across every session", async () => {
    const entryA = makeEntry("a", "claude", true);
    const entryB = makeEntry("b", "claude", true);
    const promisesA = seedPending(entryA, 1);
    const promisesB = seedPending(entryB, 1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).sessions.set("a", entryA);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).sessions.set("b", entryB);

    sm.resetAll(2);

    const results = await Promise.all([...promisesA, ...promisesB]);
    for (const r of results) {
      expect(r).toEqual({ outcome: { outcome: "cancelled" } });
    }
    expect(resolvedEvents).toHaveLength(2);
  });

  it("resolveAllPendingAsCancelled is a no-op when no pending approvals exist", async () => {
    const sessionId = "sess-empty";
    const entry = makeEntry(sessionId, "claude", true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).sessions.set(sessionId, entry);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any)._activeAgentId = "claude";

    await sm.cancelTurn(sessionId);

    expect(resolvedEvents).toHaveLength(0);
  });
});
