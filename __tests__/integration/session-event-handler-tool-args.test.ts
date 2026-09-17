// __tests__/integration/session-event-handler-tool-args.test.ts
//
// The late-arriving tool input has to reach BOTH the message cache
// (which `GET /api/agent/messages` serves on a page refresh) and the live SSE
// stream (which is what a user watching the session is looking at). A prior
// change wired the cache half only, so the live row showed `{}` for the whole call
// and the arguments appeared only after a refresh.
//
// The emit is deliberately gated on the cache having taken the value: one
// monotone rule, applied once, so the two views cannot disagree about what a
// tool was called with.

import { describe, it, expect } from "vitest";
import { SessionEventHandler } from "@/lib/agents/session-event-handler";
import type { SessionEntry } from "@/lib/sessions/types";

function makeSession(sessionId = "test-session"): SessionEntry {
  return {
    sessionId,
    agentId: "agent-1",
    title: null,
    updatedAt: null,
    active: true,
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

let counter = 0;
function makeHandler(session: SessionEntry) {
  const emittedEvents: Array<{ sessionId: string; event: { type: string } }> = [];
  const handler = new SessionEventHandler(
    { next: () => counter++ },
    (sid, event) => emittedEvents.push({ sessionId: sid, event: event as { type: string } }),
    (sid) => (sid === session.sessionId ? session : undefined),
  );
  return { handler, emittedEvents };
}

function makeNotification(sessionId: string, update: Record<string, unknown>) {
  return { sessionId, update } as Parameters<
    SessionEventHandler["handleSessionUpdate"]
  >[1];
}

function argsEvents(events: Array<{ event: { type: string } }>) {
  return events
    .map((e) => e.event as { type: string; toolCallId?: string; args?: unknown })
    .filter((e) => e.type === "agent-tool-args");
}

/** The cached `args` for a tool-call part. */
function cachedArgs(session: SessionEntry, toolCallId: string): unknown {
  for (const msg of session.messageCache) {
    for (const part of msg.parts) {
      if (part.type === "tool-call" && part.toolCallId === toolCallId) return part.args;
    }
  }
  return undefined;
}

describe("SessionEventHandler — the late tool input reaches the live stream too", () => {
  it("emits agent-tool-args when an in-progress update fills an empty input", () => {
    const session = makeSession();
    const { handler, emittedEvents } = makeHandler(session);

    // content_block_start: the tool call exists, its input has not streamed yet.
    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "Bash",
        rawInput: {},
      }),
    );
    expect(cachedArgs(session, "tc-1")).toEqual({});
    expect(argsEvents(emittedEvents)).toEqual([]);

    // …and now the real input arrives.
    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        title: "Bash",
        status: "in_progress",
        rawInput: { command: "npm test", description: "Run the suite" },
      }),
    );

    const emitted = argsEvents(emittedEvents);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.toolCallId).toBe("tc-1");
    expect(emitted[0]!.args).toEqual({ command: "npm test", description: "Run the suite" });
    // The cache took the same value — the two views agree.
    expect(cachedArgs(session, "tc-1")).toEqual({
      command: "npm test",
      description: "Run the suite",
    });
  });

  it("emits when the input only ever arrives with the completion", () => {
    const session = makeSession();
    const { handler, emittedEvents } = makeHandler(session);

    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-2",
        title: "Read",
        rawInput: {},
      }),
    );
    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-2",
        title: "Read",
        status: "completed",
        rawInput: { file_path: "/tmp/x" },
        rawOutput: "ok",
      }),
    );

    const emitted = argsEvents(emittedEvents);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.args).toEqual({ file_path: "/tmp/x" });
  });

  it("stays quiet when the update adds nothing — no event, no cache churn", () => {
    const session = makeSession();
    const { handler, emittedEvents } = makeHandler(session);

    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-3",
        title: "Bash",
        rawInput: { command: "npm test", description: "Run the suite" },
      }),
    );
    // Every one of these carries the same or less than what is cached.
    for (const rawInput of [{}, { command: "npm te" }, null, undefined]) {
      handler.handleSessionUpdate(
        session.sessionId,
        makeNotification(session.sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-3",
          title: "Bash",
          status: "in_progress",
          rawInput,
        }),
      );
    }

    expect(argsEvents(emittedEvents)).toEqual([]);
    expect(cachedArgs(session, "tc-3")).toEqual({
      command: "npm test",
      description: "Run the suite",
    });
  });
});
