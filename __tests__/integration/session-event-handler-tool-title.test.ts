// __tests__/integration/session-event-handler-tool-title.test.ts
//
// claude-agent-acp emits a Write's `tool_call` at content_block_start, before
// `file_path` has streamed, titled "Preparing file…" (an Edit's is a bare
// "Edit"). The real "Write <path>" arrives on the `tool_call_update` that
// carries the input. The handler adopted that update's `rawInput` but never its
// `title`, so every Write row kept "Preparing file…" — live, and in the cached
// history a page refresh serves (QA 2026-09-25: ~9 in one session, bug 4).

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
  const emitted: Array<{ type: string; toolCallId?: string; rawTitle?: string }> = [];
  const handler = new SessionEventHandler(
    { next: () => counter++ },
    (_sid, event) => emitted.push(event as { type: string }),
    (sid) => (sid === session.sessionId ? session : undefined),
  );
  const update = (u: Record<string, unknown>) =>
    handler.handleSessionUpdate(
      session.sessionId,
      { sessionId: session.sessionId, update: u } as Parameters<SessionEventHandler["handleSessionUpdate"]>[1],
    );
  return { update, emitted };
}

function cachedTitle(session: SessionEntry, toolCallId: string): string | undefined {
  for (const msg of session.messageCache) {
    for (const part of msg.parts) {
      if (part.type === "tool-call" && part.toolCallId === toolCallId) return part.rawTitle;
    }
  }
  return undefined;
}

const titleEvents = (emitted: Array<{ type: string }>) =>
  emitted.filter((e) => e.type === "agent-tool-title") as Array<{ type: string; toolCallId: string; rawTitle: string }>;

describe("SessionEventHandler — a Write/Edit row takes its real title", () => {
  it("replaces 'Preparing file…' with the update's 'Write <path>' in the cache and on the wire", () => {
    const session = makeSession();
    const { update, emitted } = makeHandler(session);

    update({ sessionUpdate: "tool_call", toolCallId: "w1", title: "Preparing file…", rawInput: {} });
    expect(cachedTitle(session, "w1")).toBe("Preparing file…");

    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "w1",
      title: "Write graphics/g1.js",
      rawInput: { file_path: "/agent/graphics/g1.js", content: "x" },
    });
    update({ sessionUpdate: "tool_call_update", toolCallId: "w1", status: "completed", rawOutput: "ok" });

    expect(cachedTitle(session, "w1")).toBe("Write graphics/g1.js");
    expect(titleEvents(emitted)).toEqual([
      { type: "agent-tool-title", toolCallId: "w1", rawTitle: "Write graphics/g1.js" },
    ]);
  });

  it("an Edit's bare 'Edit' becomes 'Edit <path>'", () => {
    const session = makeSession();
    const { update } = makeHandler(session);
    update({ sessionUpdate: "tool_call", toolCallId: "e1", title: "Edit", rawInput: {} });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "e1",
      status: "in_progress",
      title: "Edit notes.md",
      rawInput: { file_path: "/agent/notes.md", old_string: "a", new_string: "b" },
    });
    expect(cachedTitle(session, "e1")).toBe("Edit notes.md");
  });

  it("a title that only arrives with the completion is still adopted", () => {
    const session = makeSession();
    const { update } = makeHandler(session);
    update({ sessionUpdate: "tool_call", toolCallId: "w2", title: "Preparing file…", rawInput: {} });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "w2",
      status: "completed",
      title: "Write a.txt",
      rawInput: { file_path: "/agent/a.txt", content: "" },
      rawOutput: "ok",
    });
    expect(cachedTitle(session, "w2")).toBe("Write a.txt");
  });

  it("an update without a title, or with the same one, changes nothing and emits nothing", () => {
    const session = makeSession();
    const { update, emitted } = makeHandler(session);
    update({ sessionUpdate: "tool_call", toolCallId: "b1", title: "`npm test`", rawInput: { command: "npm test" } });
    update({ sessionUpdate: "tool_call_update", toolCallId: "b1", status: "in_progress" });
    update({ sessionUpdate: "tool_call_update", toolCallId: "b1", title: "`npm test`", rawInput: { command: "npm test" } });
    update({ sessionUpdate: "tool_call_update", toolCallId: "b1", title: "   " });
    expect(cachedTitle(session, "b1")).toBe("`npm test`");
    expect(titleEvents(emitted)).toEqual([]);
  });

  it("an MCP tool row keeps its title — it is named by its toolId, not its title", () => {
    const session = makeSession();
    const { update, emitted } = makeHandler(session);
    update({ sessionUpdate: "tool_call", toolCallId: "m1", title: "mcp__libi__get_piece_state", rawInput: {} });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "m1",
      title: "something else",
      rawInput: { pieceId: "p" },
    });
    expect(cachedTitle(session, "m1")).toBe("mcp__libi__get_piece_state");
    expect(titleEvents(emitted)).toEqual([]);
  });
});
