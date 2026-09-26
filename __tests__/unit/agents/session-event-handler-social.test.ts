/**
 * Auto-refresh path (a): an in-app chat.
 *
 * libi already observes every MCP tool call the agent makes, so when a zernio
 * WRITE completes the Social page can be refreshed over the SSE stream that is
 * already open — no polling, no second EventSource. This test drives the real
 * handler with the real update shapes rather than calling
 * `socialRefreshForTool` directly, because the thing that can silently break
 * is the wiring: a null `toolId`, an emit on the wrong branch, or an emit on
 * REPLAY (a page refresh replays a whole session, which would fire one stale
 * invalidation per historical zernio call).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionEventHandler } from "@/lib/agents/session-event-handler";
import { navigationEmitter } from "@/lib/navigation-events";
import type { AgentEvent } from "@/lib/agents/types";
import type { SessionEntry } from "@/lib/sessions/types";

let counter = 0;

function makeSession(sessionId = "social-session"): SessionEntry {
  return {
    sessionId,
    agentId: "claude",
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

function makeHandler(session: SessionEntry, sink: AgentEvent[] = []) {
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

function completedZernioWrite(toolCallId = "tc-zernio-1") {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId,
    title: "mcp__zernio__posts_create_post",
    status: "completed",
    rawInput: { content: "hello" },
    rawOutput: { post: { _id: "p1" } },
  };
}

let emit: ReturnType<typeof vi.spyOn>;

/** Only the social invalidations — the emitter carries other traffic too. */
function socialEmits(): unknown[] {
  const calls = emit.mock.calls as unknown[][];
  return calls.filter((c) => c[0] === "refresh_query").map((c) => c[1]);
}

beforeEach(() => {
  emit = vi.spyOn(navigationEmitter, "emit");
});
afterEach(() => {
  emit.mockRestore();
});

describe("a completed zernio write refreshes the social queries", () => {
  it("emits refresh_query social exactly once", () => {
    const session = makeSession();
    makeHandler(session).handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, completedZernioWrite()),
    );
    expect(socialEmits()).toEqual([{ queryKey: "social" }]);
  });

  it("emits for the codex wire shape too (structured rawInput, never the title)", () => {
    const session = makeSession("codex-social");
    makeHandler(session).handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-codex-1",
        title: "mcp.zernio.posts_publish_now",
        status: "completed",
        rawInput: { server: "zernio", tool: "posts_publish_now", arguments: { post_id: "p1" } },
        rawOutput: { ok: true },
        _meta: { is_mcp_tool_call: true },
      }),
    );
    expect(socialEmits()).toEqual([{ queryKey: "social" }]);
  });

  it("does not emit while the session is replaying", () => {
    const session = makeSession();
    session.isReplaying = true;
    makeHandler(session).handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, completedZernioWrite("tc-replay")),
    );
    expect(socialEmits()).toEqual([]);
  });

  it("does not emit when the call FAILED", () => {
    const session = makeSession();
    makeHandler(session).handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, { ...completedZernioWrite("tc-failed"), status: "failed" }),
    );
    expect(socialEmits()).toEqual([]);
  });

  it("does not emit for a zernio READ", () => {
    const session = makeSession();
    makeHandler(session).handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-read",
        title: "mcp__zernio__posts_list_posts",
        status: "completed",
        rawInput: {},
        rawOutput: { posts: [] },
      }),
    );
    expect(socialEmits()).toEqual([]);
  });

  it("does not emit for another server's tool call", () => {
    const session = makeSession();
    makeHandler(session).handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-libi",
        title: "mcp__libi__libi_list_pieces",
        status: "completed",
        rawInput: {},
        rawOutput: { pieces: [] },
      }),
    );
    expect(socialEmits()).toEqual([]);
  });

  /**
   * THE REGRESSION THIS FILE EXISTS FOR.
   *
   * Captured live in the worktree on 2026-09-20 (test mode, fake zernio, an
   * in-app claude chat asked to call `posts_create`): claude opens the call
   * with the MCP name, and COMPLETES it with `toolCallId` + `status` + content
   * and NOTHING else — no title, no `rawInput`. The emitted result event
   * carries `rawTitle: ""` and `toolId: null`.
   *
   * The first cut of this hook canonicalized from the completion alone, so it
   * never fired for the agent it was written for. Only the other test below —
   * which hands the completion a title it does not really have — passed. This
   * one feeds the two updates exactly as claude sends them.
   */
  it("emits for claude's real shape: the id is on the tool_call, not on the completion", () => {
    const session = makeSession();
    const events: AgentEvent[] = [];
    const handler = makeHandler(session, events);
    handler.handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "toolu_claude_1",
        title: "mcp__zernio__posts_create",
        kind: "other",
        status: "pending",
        rawInput: { content: "hello from task 14" },
      }),
    );
    handler.handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_claude_1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "Post post_069520eac8 — draft" } }],
      }),
    );
    // The result event really does come through with a null id; the hook must
    // not depend on it.
    const done = events.find((e) => e.type === "agent-tool-result");
    expect((done as { toolId: unknown }).toolId).toBeNull();
    expect(socialEmits()).toEqual([{ queryKey: "social" }]);
  });

  it("does not emit for a claude READ that completes the same way", () => {
    const session = makeSession();
    const handler = makeHandler(session);
    handler.handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "toolu_claude_2",
        title: "mcp__zernio__accounts_list",
        rawInput: {},
      }),
    );
    handler.handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_claude_2",
        status: "completed",
      }),
    );
    expect(socialEmits()).toEqual([]);
  });

  it("does not emit on the in-progress update, only on completion", () => {
    const session = makeSession();
    const handler = makeHandler(session);
    handler.handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-inflight",
        title: "mcp__zernio__posts_create_post",
        rawInput: { content: "hello" },
      }),
    );
    expect(socialEmits()).toEqual([]);
    handler.handleSessionUpdate(
      session.sessionId,
      notify(session.sessionId, completedZernioWrite("tc-inflight")),
    );
    expect(socialEmits()).toEqual([{ queryKey: "social" }]);
  });
});
