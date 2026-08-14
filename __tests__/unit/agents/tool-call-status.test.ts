import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionEventHandler } from "@/lib/agents/session-event-handler";
import type { SessionEntry } from "@/lib/sessions/types";
import type { AgentEvent } from "@/lib/agents/types";

vi.mock("@/lib/jobs/manager", () => ({
  getJobManager: () => ({
    getJobIdForToolCallId: () => null,
    attachToolCallId: () => {},
    on: () => {},
    off: () => {},
  }),
}));
vi.mock("@/lib/db/settings", () => ({
  getNotificationsSetting: () => ({ backgroundJobComplete: false }),
}));

function makeSession(): SessionEntry {
  return {
    sessionId: "s1",
    agentId: "claude-code",
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

function toolCallUpdate(toolCallId: string, extra: Record<string, unknown>) {
  return {
    sessionId: "s1",
    update: { sessionUpdate: "tool_call_update", toolCallId, ...extra },
  } as never;
}

describe("tool-call lifecycle status", () => {
  let session: SessionEntry;
  let events: AgentEvent[];
  let handler: SessionEventHandler;

  beforeEach(() => {
    session = makeSession();
    events = [];
    handler = new SessionEventHandler(
      { next: (() => { let n = 0; return () => n++; })() },
      (_sid, ev) => events.push(ev),
      () => session,
    );
  });

  function announce(toolCallId: string, title = "libi.dev_slow_job") {
    handler.handleSessionUpdate("s1", {
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title,
        rawInput: { seconds: 5 },
      },
    } as never);
  }

  function part(toolCallId: string) {
    for (const m of session.messageCache) {
      const p = m.parts.find(
        (x) => x.type === "tool-call" && x.toolCallId === toolCallId,
      );
      if (p) return p as Extract<typeof p, { type: "tool-call" }>;
    }
    return undefined;
  }

  it("announced tool calls start pending with startedAt", () => {
    announce("tc-1");
    expect(part("tc-1")).toMatchObject({ status: "pending" });
    expect(part("tc-1")!.startedAt).toBeTypeOf("number");
    expect(part("tc-1")!.runningAt).toBeUndefined();
  });

  it("in_progress heartbeat flips to running and backdates from elapsedTimeSeconds", () => {
    announce("tc-1");
    const before = Date.now();
    handler.handleSessionUpdate(
      "s1",
      toolCallUpdate("tc-1", {
        status: "in_progress",
        _meta: { claudeCode: { toolResponse: { elapsedTimeSeconds: 10 } } },
      }),
    );
    const p = part("tc-1")!;
    expect(p.status).toBe("running");
    expect(p.runningAt!).toBeLessThanOrEqual(before - 9_000);
    const statusEvents = events.filter((e) => e.type === "agent-tool-status");
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0]).toMatchObject({ toolCallId: "tc-1", status: "running" });
    // Idempotent: second heartbeat does not re-stamp or re-emit.
    const stamped = p.runningAt;
    handler.handleSessionUpdate(
      "s1",
      toolCallUpdate("tc-1", { status: "in_progress" }),
    );
    expect(part("tc-1")!.runningAt).toBe(stamped);
    expect(events.filter((e) => e.type === "agent-tool-status")).toHaveLength(1);
  });

  it("sibling result flips the OLDEST remaining pending call (sequential execution)", () => {
    announce("tc-1");
    announce("tc-2");
    announce("tc-3");
    handler.handleSessionUpdate(
      "s1",
      toolCallUpdate("tc-1", { status: "completed", title: "libi.dev_slow_job", rawOutput: "ok" }),
    );
    expect(part("tc-2")!.status).toBe("running");
    expect(part("tc-3")!.status).toBe("pending");
  });

  it("message-end refinement update flips the OLDEST pending call", () => {
    announce("tc-1");
    announce("tc-2");
    // Refinement: no status, carries rawInput/title (claude-agent-acp sends
    // this when the assistant message finishes streaming = execution starts).
    handler.handleSessionUpdate(
      "s1",
      toolCallUpdate("tc-2", { rawInput: { seconds: 5 }, title: "libi.dev_slow_job" }),
    );
    expect(part("tc-1")!.status).toBe("running");
    expect(part("tc-2")!.status).toBe("pending");
  });

  it("completion appends the result (with completedAt) to the message holding the call and clears status", () => {
    announce("tc-1");
    // Force a NEW current message (turn boundary) so the naive
    // ensureAgentMessage would target the wrong message.
    session.currentAgentMessage = null;
    handler.handleSessionUpdate(
      "s1",
      toolCallUpdate("tc-1", { status: "completed", title: "t", rawOutput: { ok: 1 } }),
    );
    const holder = session.messageCache.find((m) =>
      m.parts.some((p) => p.type === "tool-call" && p.toolCallId === "tc-1"),
    )!;
    const result = holder.parts.find(
      (p) => p.type === "tool-result" && p.toolCallId === "tc-1",
    ) as Extract<(typeof holder.parts)[number], { type: "tool-result" }>;
    expect(result).toBeDefined();
    expect(result.completedAt).toBeTypeOf("number");
    expect(part("tc-1")!.status).toBeUndefined();
  });

  // Hardening (P2T1 review findings): the sequential inference must never
  // produce TWO running tools, and a running subagent in the same batch
  // blocks the flip entirely.
  it("inference no-ops when a LATER sibling is already running (out-of-order signal)", () => {
    announce("tc-1");
    announce("tc-2");
    // Out-of-order direct signal: tc-2 gets a heartbeat while tc-1 is pending.
    handler.handleSessionUpdate("s1", toolCallUpdate("tc-2", { status: "in_progress" }));
    expect(part("tc-2")!.status).toBe("running");
    // Refinement arrives — must NOT flip tc-1 (tc-2 is executing).
    handler.handleSessionUpdate(
      "s1",
      toolCallUpdate("tc-1", { rawInput: {}, title: "libi.dev_slow_job" }),
    );
    expect(part("tc-1")!.status).toBe("pending");
  });

  it("replay ingests subagent dispatches without startedAt (no bogus Task timers)", () => {
    session.isReplaying = true;
    handler.handleSessionUpdate("s1", {
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-task-r",
        title: "Task",
        rawInput: {},
      },
    } as never);
    const sub = session.messageCache
      .flatMap((m) => m.parts)
      .find((p) => p.type === "subagent" && p.toolCallId === "tc-task-r") as
      | { startedAt?: number; status: string }
      | undefined;
    expect(sub).toBeDefined();
    expect(sub!.startedAt).toBeUndefined();
  });

  it("live subagent dispatches still stamp startedAt", () => {
    handler.handleSessionUpdate("s1", {
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-task-l",
        title: "Task",
        rawInput: {},
      },
    } as never);
    const sub = session.messageCache
      .flatMap((m) => m.parts)
      .find((p) => p.type === "subagent" && p.toolCallId === "tc-task-l") as
      | { startedAt?: number }
      | undefined;
    expect(sub!.startedAt).toBeTypeOf("number");
  });

  it("replay ingests no timestamps and no status", () => {
    session.isReplaying = true;
    announce("tc-r");
    const p = part("tc-r")!;
    expect(p.startedAt).toBeUndefined();
    expect(p.status).toBeUndefined();
    handler.handleSessionUpdate(
      "s1",
      toolCallUpdate("tc-r", { status: "completed", title: "t", rawOutput: "ok" }),
    );
    const holder = session.messageCache.find((m) =>
      m.parts.some((q) => q.type === "tool-call" && q.toolCallId === "tc-r"),
    )!;
    const result = holder.parts.find(
      (q) => q.type === "tool-result" && q.toolCallId === "tc-r",
    ) as { completedAt?: number };
    expect(result.completedAt).toBeUndefined();
  });

  it("inference no-ops while a subagent in the same message is running", () => {
    announce("tc-1");
    // Inject a running subagent part announced BEFORE the pending tool
    // completes its startup (Task + MCP tool batched in one message).
    const msg = session.messageCache[session.messageCache.length - 1];
    msg.parts.unshift({
      type: "subagent",
      toolCallId: "tc-task",
      subagentType: "general-purpose",
      description: "long analysis",
      prompt: "…",
      model: null,
      background: false,
      startedAt: Date.now(),
      status: "running",
      result: null,
      usage: null,
      agentId: null,
    });
    // Subagent refinement update (bare) must not flip the regular tool.
    handler.handleSessionUpdate(
      "s1",
      toolCallUpdate("tc-task", { rawInput: { prompt: "x" }, title: "Task" }),
    );
    expect(part("tc-1")!.status).toBe("pending");
  });
});
