// __tests__/integration/session-event-handler-subagent.test.ts
//
// Verifies that SessionEventHandler correctly detects Task/Agent tool_call
// ACP updates and stores `subagent` parts (not `tool-call` parts) in the
// messageCache, and that the corresponding tool_call_update mutates those
// parts in-place rather than appending a `tool-result` part.

import { describe, it, expect, vi } from "vitest";
import { SessionEventHandler } from "@/lib/agents/session-event-handler";
import type { SessionEntry } from "@/lib/sessions/types";
import type { AgentMessagePart } from "@/lib/agents/message-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const emittedEvents: Array<{ sessionId: string; event: unknown }> = [];
  const handler = new SessionEventHandler(
    { next: () => counter++ },
    (sid, event) => emittedEvents.push({ sessionId: sid, event }),
    (sid) => (sid === session.sessionId ? session : undefined),
  );
  return { handler, emittedEvents };
}

// Build a minimal ACP SessionNotification wrapper
function makeNotification(sessionId: string, update: Record<string, unknown>) {
  return { sessionId, update } as Parameters<
    SessionEventHandler["handleSessionUpdate"]
  >[1];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionEventHandler — subagent detection in messageCache", () => {
  it("stores a `subagent` part (not `tool-call`) when toolName is 'Task'", () => {
    const session = makeSession();
    const { handler } = makeHandler(session);

    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-001",
        title: "Task",
        rawInput: {
          description: "Describe 12 keyframes",
          subagent_type: "general-purpose",
          model: "sonnet",
          run_in_background: false,
          prompt: "Describe each frame...",
        },
      }),
    );

    expect(session.messageCache).toHaveLength(1);
    const msg = session.messageCache[0];
    expect(msg.role).toBe("agent");
    expect(msg.parts).toHaveLength(1);

    const part = msg.parts[0];
    expect(part.type).toBe("subagent");
    if (part.type !== "subagent") return; // narrow for TS

    expect(part.toolCallId).toBe("tc-001");
    expect(part.subagentType).toBe("general-purpose");
    expect(part.description).toBe("Describe 12 keyframes");
    expect(part.prompt).toBe("Describe each frame...");
    expect(part.model).toBe("sonnet");
    expect(part.background).toBe(false);
    expect(part.status).toBe("running");
    expect(part.result).toBeNull();
    expect(part.usage).toBeNull();
    expect(part.agentId).toBeNull();
  });

  it("stores a `subagent` part when toolName is 'Agent'", () => {
    const session = makeSession();
    const { handler } = makeHandler(session);

    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-002",
        title: "Agent",
        rawInput: {
          description: "Run background task",
          subagent_type: "Explore",
          run_in_background: true,
          prompt: "Explore the codebase...",
        },
      }),
    );

    const part = session.messageCache[0]?.parts[0];
    expect(part?.type).toBe("subagent");
    if (part?.type !== "subagent") return;
    expect(part.background).toBe(true);
    expect(part.model).toBeNull();
    expect(part.agentId).toBeNull();
  });

  it("falls back to `tool-call` part for non-subagent tools", () => {
    const session = makeSession();
    const { handler } = makeHandler(session);

    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-003",
        title: "libi.create_scene",
        rawInput: { pieceId: "p1", name: "Scene 1", duration: 5 },
      }),
    );

    const part = session.messageCache[0]?.parts[0];
    expect(part?.type).toBe("tool-call");
    if (part?.type !== "tool-call") return;
    // rawTitle here is the dotted libi.* name (not the mcp__ wire form),
    // which is neither canonical nor wire form — fromAnyToolName returns
    // null and we keep the rawTitle as the display source.
    expect(part.toolId).toBeNull();
    expect(part.rawTitle).toBe("libi.create_scene");
  });

  it("creates a minimal subagent part even when Task input is missing fields", () => {
    // Replay shape (claude-agent-acp's loadSession returns args:{} for
    // Task tools) — we still want a SubagentCard so the dispatch keeps
    // its identity, instead of being grouped among regular tool calls
    // with its result dumped inline as JSON. See session e3a76709.
    const session = makeSession();
    const { handler } = makeHandler(session);

    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-004",
        title: "Task",
        rawInput: { description: "no subagent_type field" },
      }),
    );

    const part = session.messageCache[0]?.parts[0];
    expect(part?.type).toBe("subagent");
    if (part?.type !== "subagent") return;
    expect(part.subagentType).toBe("unknown");
    // Falls back to the tool name as a placeholder description.
    expect(part.description).toBe("Task");
  });

  it("updates subagent part in-place on completion (not appending tool-result)", () => {
    const session = makeSession();
    const { handler } = makeHandler(session);

    // Dispatch
    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-010",
        title: "Task",
        rawInput: {
          description: "Frame description batch",
          subagent_type: "general-purpose",
          prompt: "Describe frames...",
        },
      }),
    );

    const taskNotification =
      "<task-notification>" +
      "<status>completed</status>" +
      '<result>{"ok":1}</result>' +
      "<usage>total_tokens: 5000\ntool_uses: 3\nduration_ms: 12000</usage>" +
      "</task-notification>";

    // Completion
    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-010",
        title: "Task",
        status: "completed",
        rawOutput: taskNotification,
      }),
    );

    // Only ONE part: the subagent (not a second tool-result appended)
    const msg = session.messageCache[0];
    expect(msg.parts).toHaveLength(1);

    const part = msg.parts[0] as Extract<AgentMessagePart, { type: "subagent" }>;
    expect(part.type).toBe("subagent");
    expect(part.status).toBe("completed");
    expect(part.result).toBe('{"ok":1}');
    expect(part.usage).toEqual({ totalTokens: 5000, toolUses: 3, durationMs: 12000 });
  });

  it("captures agentId from async ack without overwriting status", () => {
    const session = makeSession();
    const { handler } = makeHandler(session);

    // Dispatch
    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-020",
        title: "Task",
        rawInput: {
          description: "Background task",
          subagent_type: "general-purpose",
          run_in_background: true,
          prompt: "Do stuff in background...",
        },
      }),
    );

    // Ack (not a task-notification — just agentId)
    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-020",
        title: "Task",
        status: "completed",
        rawOutput: "Async agent launched successfully.\nagentId: a02a7670feede2f04",
      }),
    );

    const part = session.messageCache[0]?.parts[0] as Extract<
      AgentMessagePart,
      { type: "subagent" }
    >;
    expect(part.type).toBe("subagent");
    // Status stays running (ack is not a completion)
    expect(part.status).toBe("running");
    expect(part.agentId).toBe("a02a7670feede2f04");
  });

  it("emits agent-tool-call SSE event for subagent dispatch", () => {
    const session = makeSession();
    const { handler, emittedEvents } = makeHandler(session);

    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-030",
        title: "Task",
        rawInput: {
          description: "Emit test",
          subagent_type: "general-purpose",
          prompt: "...",
        },
      }),
    );

    const emitted = emittedEvents.find(
      (e) =>
        e.sessionId === session.sessionId &&
        (e.event as { type: string }).type === "agent-tool-call",
    );
    expect(emitted).toBeDefined();
    const evt = emitted!.event as {
      type: string;
      toolId: string | null;
      rawTitle: string;
      toolCallId: string;
    };
    // Built-in Task tool — no canonical MCP id, rawTitle stays "Task".
    expect(evt.toolId).toBeNull();
    expect(evt.rawTitle).toBe("Task");
    expect(evt.toolCallId).toBe("tc-030");
  });

  it("refines a placeholder Task subagent when rawInput arrives in a follow-up tool_call_update", () => {
    // claude-agent-acp emits tool_call at content_block_start with empty
    // input (title="Task"), then a tool_call_update once the assistant
    // message finishes streaming with the FULL rawInput. Without
    // refinement the subagent card stays stuck at description="Task" for
    // the entire run and on every replay afterward — see session
    // 108d13a5.
    const session = makeSession();
    const { handler, emittedEvents } = makeHandler(session);

    // Phase 1 — empty input from content_block_start
    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-040",
        title: "Task",
        rawInput: {},
      }),
    );

    let part = session.messageCache[0].parts[0] as Extract<
      AgentMessagePart,
      { type: "subagent" }
    >;
    expect(part.description).toBe("Task");
    expect(part.prompt).toBe("");

    // Phase 2 — assistant message complete carries the full input
    handler.handleSessionUpdate(
      session.sessionId,
      makeNotification(session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-040",
        title: "Describe 10 video frames",
        rawInput: {
          description: "Describe 10 video frames",
          subagent_type: "general-purpose",
          model: "sonnet",
          run_in_background: false,
          prompt: "You are a vision describer...",
        },
      }),
    );

    part = session.messageCache[0].parts[0] as Extract<
      AgentMessagePart,
      { type: "subagent" }
    >;
    expect(part.type).toBe("subagent");
    expect(part.description).toBe("Describe 10 video frames");
    expect(part.subagentType).toBe("general-purpose");
    expect(part.prompt).toBe("You are a vision describer...");
    expect(part.model).toBe("sonnet");
    expect(part.status).toBe("running");

    const refineEvt = emittedEvents.find(
      (e) =>
        e.sessionId === session.sessionId &&
        (e.event as { type: string }).type === "agent-subagent-refine",
    );
    expect(refineEvt).toBeDefined();
  });
});
