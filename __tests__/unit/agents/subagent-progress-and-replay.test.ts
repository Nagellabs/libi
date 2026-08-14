/**
 * Subagent rendering edge cases the chat UI used to mishandle:
 *
 * 1. Live `tool_call_update` content for a Task/Agent dispatch must
 *    patch the `subagent` part's `progress` field — without this, a
 *    long-running sub-agent shows only an elapsed timer with no hint
 *    of what it's actually doing.
 *
 * 2. Replay-shape `tool_call` (claude-agent-acp's loadSession returns
 *    `args: {}` for Task tools) must still render as a SubagentCard,
 *    not a regular tool-call. Otherwise the result JSON dumps inline
 *    among tool calls and the dispatch loses its identity.
 *
 * 3. Subagent completion without a `<task-notification>` block (raw
 *    text reply) must still flip the part out of the "running" state.
 */
import { describe, it, expect } from "vitest";
import { SessionEventHandler } from "@/lib/agents/session-event-handler";
import type { SessionEntry } from "@/lib/sessions/types";

let counter = 0;
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

function makeHandler(session: SessionEntry) {
  const events: Array<{ sessionId: string; event: unknown }> = [];
  const handler = new SessionEventHandler(
    { next: () => counter++ },
    (sid, event) => events.push({ sessionId: sid, event }),
    (sid) => (sid === session.sessionId ? session : undefined),
  );
  return { handler, events };
}

function makeNotification(sessionId: string, update: Record<string, unknown>) {
  return { sessionId, update } as Parameters<
    SessionEventHandler["handleSessionUpdate"]
  >[1];
}

describe("subagent — live progress updates", () => {
  it("tool_call_update content patches the subagent part's progress field", () => {
    const session = makeSession();
    const { handler, events } = makeHandler(session);

    // Live dispatch with full input.
    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-sub",
        title: "Task",
        rawInput: {
          description: "Describe 10 frames",
          subagent_type: "general-purpose",
          prompt: "...",
        },
      }),
    );

    // Mid-flight progress notification.
    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-sub",
        title: "Task",
        status: "in_progress",
        content: [
          { type: "content", content: { type: "text", text: "Reading frame-0001.png" } },
        ],
      }),
    );

    const part = session.messageCache[0]?.parts[0];
    expect(part?.type).toBe("subagent");
    if (part?.type !== "subagent") return;
    expect(part.progress).toBe("Reading frame-0001.png");

    // The progress event should also have been fan-out for live SSE.
    const progressEvent = events.find(
      (e) => (e.event as { type?: string }).type === "agent-tool-progress",
    );
    expect(progressEvent).toBeDefined();
  });

  it("multiple progress updates overwrite the previous value", () => {
    const session = makeSession();
    const { handler } = makeHandler(session);

    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-x",
        title: "Task",
        rawInput: {
          description: "Describe frames",
          subagent_type: "general-purpose",
          prompt: "",
        },
      }),
    );

    for (const text of ["Reading frame 1", "Reading frame 2", "Reading frame 3"]) {
      handler.handleSessionUpdate(
        session.sessionId,
        makeNotification(session.sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-x",
          title: "Task",
          status: "in_progress",
          content: [{ type: "content", content: { type: "text", text } }],
        }),
      );
    }

    const part = session.messageCache[0]?.parts[0];
    if (part?.type !== "subagent") throw new Error("expected subagent");
    expect(part.progress).toBe("Reading frame 3");
  });
});

describe("subagent — detection by args shape", () => {
  it("treats title='Describe video keyframes' as a subagent dispatch when args carry subagent_type", () => {
    // claude-agent-acp uses the dispatch's `description` as the tool
    // title when present, so the title is no longer "Task". The
    // shape-based detector must still classify this as a subagent.
    const session = makeSession();
    const { handler } = makeHandler(session);
    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-shape",
        title: "Describe video keyframes",
        rawInput: {
          description: "Describe video keyframes",
          subagent_type: "general-purpose",
          prompt: "Read every PNG frame and return a JSON array...",
        },
      }),
    );
    const part = session.messageCache[0]?.parts[0];
    expect(part?.type).toBe("subagent");
    if (part?.type !== "subagent") return;
    expect(part.description).toBe("Describe video keyframes");
    expect(part.subagentType).toBe("general-purpose");
  });

  it("completion patches the subagent part even when toolName is the description", () => {
    const session = makeSession();
    const { handler } = makeHandler(session);
    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-shape-2",
        title: "Describe video keyframes",
        rawInput: {
          description: "Describe video keyframes",
          subagent_type: "general-purpose",
          prompt: "...",
        },
      }),
    );
    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-shape-2",
        title: "Describe video keyframes",
        status: "completed",
        rawOutput: '[{"schema_version":"frame_v1","frame_index":0}]',
      }),
    );
    // Should still be exactly one subagent part — no extra tool-result
    // appended, no JSON dumped inline.
    expect(session.messageCache[0].parts).toHaveLength(1);
    const part = session.messageCache[0]?.parts[0];
    if (part?.type !== "subagent") throw new Error("expected subagent");
    expect(part.status).toBe("completed");
    expect(part.result).toContain("frame_v1");
  });
});

describe("subagent — replay shape (empty args)", () => {
  it("creates a SubagentCard even when rawInput is empty/missing", () => {
    const session = makeSession();
    const { handler } = makeHandler(session);

    // Simulate claude-agent-acp's loadSession output for a Task tool —
    // toolName is set but rawInput is missing the description/prompt.
    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-replay",
        title: "Task",
        rawInput: {},
      }),
    );

    const part = session.messageCache[0]?.parts[0];
    expect(part?.type).toBe("subagent");
    if (part?.type !== "subagent") return;
    // Falls back to the tool name as the description so the card has
    // *some* identity rather than dumping the result as a tool-call.
    expect(part.description).toBe("Task");
    expect(part.subagentType).toBe("unknown");
    expect(part.status).toBe("running");
  });

  it("'Agent' tool name with empty args also goes through the subagent path", () => {
    const session = makeSession();
    const { handler } = makeHandler(session);
    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-agent",
        title: "Agent",
        rawInput: undefined,
      }),
    );
    const part = session.messageCache[0]?.parts[0];
    expect(part?.type).toBe("subagent");
    if (part?.type !== "subagent") return;
    expect(part.description).toBe("Agent");
  });
});

describe("subagent — completion without task-notification block", () => {
  it("flips status to 'completed' and stashes raw text result", () => {
    const session = makeSession();
    const { handler } = makeHandler(session);

    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-c",
        title: "Task",
        rawInput: {
          description: "Describe frames",
          subagent_type: "general-purpose",
          prompt: "",
        },
      }),
    );

    // Real-world reply: a JSON array with no <task-notification> wrapper.
    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-c",
        title: "Task",
        status: "completed",
        rawOutput: [{ schema_version: "frame_v1", frame_index: 0 }],
      }),
    );

    const part = session.messageCache[0]?.parts[0];
    if (part?.type !== "subagent") throw new Error("expected subagent");
    expect(part.status).toBe("completed");
    expect(part.result).toContain("frame_v1");
  });

  it("flips status to 'failed' on failed completion with no notification", () => {
    const session = makeSession();
    const { handler } = makeHandler(session);
    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-f",
        title: "Task",
        rawInput: {
          description: "x",
          subagent_type: "general-purpose",
          prompt: "",
        },
      }),
    );
    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-f",
        title: "Task",
        status: "failed",
        rawOutput: "boom",
      }),
    );
    const part = session.messageCache[0]?.parts[0];
    if (part?.type !== "subagent") throw new Error("expected subagent");
    expect(part.status).toBe("failed");
    expect(part.result).toBe("boom");
  });
});
