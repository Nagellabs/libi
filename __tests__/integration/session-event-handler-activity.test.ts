// __tests__/integration/session-event-handler-activity.test.ts
//
// A cancelled prompt stops counting as in flight only after the session has
// been SILENT for CANCEL_SETTLE_TIMEOUT_MS (session-manager `cancelTurn`).
// "Silent" is read from `lastAgentActivityAt`, which the event handler stamps
// on every live update — so an adapter still finishing a tool it could not
// interrupt keeps its chat busy.

import { describe, it, expect } from "vitest";
import { SessionEventHandler } from "@/lib/agents/session-event-handler";
import type { SessionEntry } from "@/lib/sessions/types";

function makeSession(): SessionEntry {
  return {
    sessionId: "act-1",
    agentId: "claude-code",
    title: null,
    updatedAt: null,
    active: true,
    lastUsed: 0,
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

function handlerFor(session: SessionEntry) {
  let n = 0;
  const handler = new SessionEventHandler({ next: () => n++ }, () => {}, (sid) => (sid === session.sessionId ? session : undefined));
  return (update: Record<string, unknown>) =>
    handler.handleSessionUpdate(session.sessionId, { sessionId: session.sessionId, update } as Parameters<SessionEventHandler["handleSessionUpdate"]>[1]);
}

describe("SessionEventHandler stamps agent activity", () => {
  it("any live update (text, tool progress) stamps lastAgentActivityAt", () => {
    const session = makeSession();
    const update = handlerFor(session);
    const before = Date.now();
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "still working" } });
    expect(session.lastAgentActivityAt).toBeGreaterThanOrEqual(before);

    session.lastAgentActivityAt = 0;
    update({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "in_progress" });
    expect(session.lastAgentActivityAt).toBeGreaterThanOrEqual(before);
  });

  it("a history replay is not activity", () => {
    const session = makeSession();
    session.isReplaying = true;
    handlerFor(session)({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old" } });
    expect(session.lastAgentActivityAt).toBeUndefined();
  });
});
