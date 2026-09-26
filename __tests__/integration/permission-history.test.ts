// __tests__/integration/permission-history.test.ts
//
// A pending approval must survive a page reload. The request used to be
// emit-only, so a client that reloaded mid-wait got it back only from the SSE
// reconnect re-send — and when those frames beat the history fetch, the
// history load replaced the live message holding the card: the chat showed
// busy with nothing to answer (review of bug 3, 2026-09-25). The card now
// lives in the server's message cache, i.e. in the history itself, and is
// marked resolved there when it is answered or cancelled.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/approval/settings", () => ({ getApprovalMode: vi.fn(() => "ask") }));

import { SessionEventHandler } from "@/lib/agents/session-event-handler";
import { SessionManager } from "@/lib/sessions/session-manager";
import type { SessionEntry } from "@/lib/sessions/types";
import type { AgentMessage } from "@/lib/agents/message-types";
import type { RequestPermissionRequest, ClientSideConnection } from "@agentclientprotocol/sdk";

function makeSession(sessionId = "perm-s1"): SessionEntry {
  return {
    sessionId,
    agentId: "claude-code",
    title: null,
    updatedAt: null,
    active: true,
    lastUsed: Date.now(),
    messageCache: [],
    currentAgentMessage: null,
    currentUserMessage: null,
    promptsInFlight: 1,
    listeners: new Set(),
    pendingApprovals: new Map(),
    configOptions: [],
    latestUsage: null,
    availableCommands: [],
  };
}

const request = (sessionId: string): RequestPermissionRequest => ({
  sessionId,
  toolCall: { toolCallId: "tc-1", title: "`rm -rf build`", rawInput: { command: "rm -rf build" } },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ],
});

function permissionParts(cache: AgentMessage[]) {
  return cache.flatMap((m) => m.parts).filter((p) => p.type === "permission-request");
}

let n = 0;
function makeHandler(session: SessionEntry) {
  return new SessionEventHandler(
    { next: () => n++ },
    () => {},
    (sid) => (sid === session.sessionId ? session : undefined),
  );
}

describe("a pending approval is part of the session's history", () => {
  beforeEach(() => { n = 0; });

  it("the request is cached as a pending card in the current agent message", async () => {
    const session = makeSession();
    const handler = makeHandler(session);
    void handler.handlePermissionRequest(request(session.sessionId));
    await Promise.resolve();
    await Promise.resolve();

    const [pendingId] = [...session.pendingApprovals.keys()];
    expect(pendingId).toBeDefined();
    const parts = permissionParts(session.messageCache);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: "permission-request",
      pendingId,
      status: "pending",
      reason: "acp",
      options: request(session.sessionId).options,
    });
    // In the message the turn is streaming into — the one the client adopts.
    expect(session.currentAgentMessage?.parts).toContain(parts[0]);
  });

  it("a cancelled turn marks the cached card resolved (so a reload shows it answered)", async () => {
    const sm = new SessionManager();
    sm.setProcessManager({
      getConnection: vi.fn(() => ({ cancel: vi.fn(async () => {}) }) as unknown as ClientSideConnection),
      warmProcess: vi.fn(async () => {}),
      getCapabilitiesForAgent: vi.fn(() => ({ canListSessions: true })),
      registerSessionId: vi.fn(),
      unregisterSessionId: vi.fn(),
    } as never);
    const session = makeSession("perm-s2");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sm as any).sessions.set(session.sessionId, session);
    const handler = makeHandler(session);
    void handler.handlePermissionRequest(request(session.sessionId));
    await Promise.resolve();
    await Promise.resolve();

    await sm.cancelTurn(session.sessionId);

    expect(permissionParts(session.messageCache)[0]).toMatchObject({
      status: "resolved",
      outcome: { kind: "cancelled" },
    });
  });
});
