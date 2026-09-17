/**
 * An ordinary tool call must end up carrying its ARGUMENTS.
 *
 * claude-agent-acp emits `tool_call` at the assistant message's
 * content_block_start, before the tool's input has finished streaming, so
 * `rawInput` is empty there and the real arguments arrive on a later
 * `tool_call_update`. Only the subagent branch consumed that refinement, so
 * every ordinary call kept the empty `{}` it was created with — which is what
 * the skill-eval transcript rendered (`[tool-call mcp__libi-app__libi_show_piece] {}`
 * for every call in every run), and what the chat row's detail line reads.
 */
import { describe, it, expect } from "vitest";
import { SessionEventHandler } from "@/lib/agents/session-event-handler";
import type { SessionEntry } from "@/lib/sessions/types";

let counter = 0;
function makeSession(sessionId = "args-session"): SessionEntry {
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
  return new SessionEventHandler(
    { next: () => counter++ },
    () => {},
    (sid) => (sid === session.sessionId ? session : undefined),
  );
}

function notify(sessionId: string, update: Record<string, unknown>) {
  return { sessionId, update } as Parameters<SessionEventHandler["handleSessionUpdate"]>[1];
}

function argsOf(session: SessionEntry, toolCallId: string): unknown {
  for (const msg of session.messageCache) {
    for (const part of msg.parts) {
      if (part.type === "tool-call" && part.toolCallId === toolCallId) return part.args;
    }
  }
  throw new Error(`no tool-call part ${toolCallId}`);
}

describe("ordinary tool-call args are refined from the update that carries them", () => {
  it("fills args that arrived empty on the tool_call", () => {
    const session = makeSession();
    const handler = makeHandler(session);
    handler.handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "mcp__libi-app__libi_show_piece",
        rawInput: {},
      }),
    );
    expect(argsOf(session, "tc-1")).toEqual({});

    handler.handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        title: "mcp__libi-app__libi_show_piece",
        rawInput: { pieceId: "piece-7" },
      }),
    );
    expect(argsOf(session, "tc-1")).toEqual({ pieceId: "piece-7" });
  });

  it("fills them from a completed update too, when that is the first one carrying input", () => {
    const session = makeSession();
    const handler = makeHandler(session);
    handler.handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-2",
        title: "Bash",
      }),
    );
    handler.handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-2",
        title: "Bash",
        status: "completed",
        rawInput: { command: "ls -la" },
        rawOutput: "…",
      }),
    );
    expect(argsOf(session, "tc-2")).toEqual({ command: "ls -la" });
  });

  it("takes the fuller input when an in-flight update was still streaming a partial one", () => {
    // Observed in a real skill-eval run: the first update carried only
    // `{ pieceId }` for an upload whose `filePath` had not finished streaming.
    const session = makeSession();
    const handler = makeHandler(session);
    handler.handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-4",
        title: "mcp__libi-app__libi_upload_file",
        rawInput: {},
      }),
    );
    for (const rawInput of [
      { pieceId: "p1" },
      { pieceId: "p1", filePath: "__tests__/fixtures/audio/jfk.wav" },
    ]) {
      handler.handleSessionUpdate(
        session.sessionId,
        notify(session.sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-4",
          title: "mcp__libi-app__libi_upload_file",
          rawInput,
        }),
      );
    }
    expect(argsOf(session, "tc-4")).toEqual({
      pieceId: "p1",
      filePath: "__tests__/fixtures/audio/jfk.wav",
    });
  });

  it("never loses args to a later, poorer update", () => {
    const session = makeSession();
    const handler = makeHandler(session);
    handler.handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-3",
        title: "Read",
        rawInput: { file_path: "/a/b.ts", limit: 50 },
      }),
    );
    handler.handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-3",
        title: "Read",
        status: "in_progress",
        rawInput: {},
      }),
    );
    expect(argsOf(session, "tc-3")).toEqual({ file_path: "/a/b.ts", limit: 50 });
  });
});
