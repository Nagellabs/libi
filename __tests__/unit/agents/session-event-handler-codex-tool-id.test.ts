/**
 * A Codex MCP tool call must reach the message cache and the event stream
 * with a REAL canonical `toolId`.
 *
 * Live capture, codex CLI 0.153.4 / codex-acp 1.10.0 (spike S2, 2026-09-09):
 * the `tool_call` update for `libi.list_pieces` carries
 *
 *   title    = "mcp.libi-app.libi.list_pieces"
 *   rawInput = { server: "libi-app", tool: "libi.list_pieces", arguments: {} }
 *   _meta    = { is_mcp_tool_call: true }
 *
 * The title parser only understood the OLDER `<server>/<tool>` shape, so every
 * codex MCP call arrived with `toolId: null` and three things went blind on
 * Codex: the jobs progress bridge (which resolves a running call by canonical
 * id), the extension approval gate, and the tool labels in the chat. Nothing
 * failed — the unit tests asserted title shapes codex has never emitted.
 *
 * The fix canonicalizes from the STRUCTURED payload and keeps the title as a
 * fallback, so this test drives the handler with the real update rather than
 * calling the parser directly.
 */
import { describe, it, expect } from "vitest";
import { SessionEventHandler } from "@/lib/agents/session-event-handler";
import type { AgentEvent } from "@/lib/agents/types";
import type { SessionEntry } from "@/lib/sessions/types";

let counter = 0;

function makeSession(sessionId = "codex-session"): SessionEntry {
  return {
    sessionId,
    agentId: "codex",
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

function makeHandler(session: SessionEntry, sink: AgentEvent[]) {
  return new SessionEventHandler(
    { next: () => counter++ },
    (_sid: string, event: AgentEvent) => {
      sink.push(event);
    },
    (sid) => (sid === session.sessionId ? session : undefined),
  );
}

function notify(sessionId: string, update: Record<string, unknown>) {
  return { sessionId, update } as Parameters<SessionEventHandler["handleSessionUpdate"]>[1];
}

function cachedToolId(session: SessionEntry, toolCallId: string): unknown {
  for (const msg of session.messageCache) {
    for (const part of msg.parts) {
      if (part.type === "tool-call" && part.toolCallId === toolCallId) return part.toolId;
    }
  }
  throw new Error(`no tool-call part ${toolCallId}`);
}

/** The exact update codex-acp 1.10.0 sends for `libi.list_pieces`. */
const CODEX_TOOL_CALL = {
  sessionUpdate: "tool_call",
  toolCallId: "exec-09f66db7-1111-2222-3333-444455556666",
  title: "mcp.libi-app.libi.list_pieces",
  kind: "execute",
  rawInput: { server: "libi-app", tool: "libi.list_pieces", arguments: {} },
  _meta: { is_mcp_tool_call: true },
} as const;

describe("codex MCP tool calls canonicalize to a real toolId", () => {
  it("stamps the canonical id on the cached part and the emitted event", () => {
    const session = makeSession();
    const events: AgentEvent[] = [];
    const handler = makeHandler(session, events);

    handler.handleSessionUpdate(session.sessionId, notify(session.sessionId, { ...CODEX_TOOL_CALL }));

    expect(cachedToolId(session, CODEX_TOOL_CALL.toolCallId)).toBe("libi:libi.list_pieces");
    const emitted = events.find((e) => e.type === "agent-tool-call");
    expect(emitted).toBeDefined();
    expect((emitted as { toolId: unknown }).toolId).toBe("libi:libi.list_pieces");
  });

  it("is the SAME id claude produces for the same tool", () => {
    const codexSession = makeSession("s-codex");
    const claudeSession = makeSession("s-claude");
    const codex = makeHandler(codexSession, []);
    const claude = makeHandler(claudeSession, []);

    codex.handleSessionUpdate("s-codex", notify("s-codex", { ...CODEX_TOOL_CALL }));
    claude.handleSessionUpdate(
      "s-claude",
      notify("s-claude", {
        sessionUpdate: "tool_call",
        toolCallId: "tc-claude",
        title: "mcp__libi-app__libi_list_pieces",
        rawInput: {},
      }),
    );

    expect(cachedToolId(codexSession, CODEX_TOOL_CALL.toolCallId)).toBe(
      cachedToolId(claudeSession, "tc-claude"),
    );
  });

  it("canonicalizes a user-installed codex MCP verbatim, never null", () => {
    const session = makeSession();
    const handler = makeHandler(session, []);
    handler.handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-everything",
        title: "mcp.everything.echo",
        rawInput: { server: "everything", tool: "echo", arguments: { message: "S2-ALIVE" } },
        _meta: { is_mcp_tool_call: true },
      }),
    );
    expect(cachedToolId(session, "tc-everything")).toBe("everything:echo");
  });

  it("leaves a codex BUILT-IN call with a null id (it is not an MCP tool)", () => {
    const session = makeSession();
    const handler = makeHandler(session, []);
    handler.handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-shell",
        title: "shell",
        rawInput: { command: ["ls"] },
      }),
    );
    expect(cachedToolId(session, "tc-shell")).toBeNull();
  });

  it("carries the id onto the completion event too", () => {
    const session = makeSession();
    const events: AgentEvent[] = [];
    const handler = makeHandler(session, events);
    handler.handleSessionUpdate(session.sessionId, notify(session.sessionId, { ...CODEX_TOOL_CALL }));
    handler.handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: CODEX_TOOL_CALL.toolCallId,
        title: "mcp.libi-app.libi.list_pieces",
        status: "completed",
        rawInput: CODEX_TOOL_CALL.rawInput,
        rawOutput: { ok: true },
        _meta: { is_mcp_tool_call: true },
      }),
    );
    const done = events.find((e) => e.type === "agent-tool-result");
    expect(done).toBeDefined();
    expect((done as { toolId: unknown }).toolId).toBe("libi:libi.list_pieces");
  });
});
