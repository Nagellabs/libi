import { describe, it, expect } from "vitest";
import {
  applyAgentEvent,
  applyHistory,
  appendLocalUserMessage,
  markLocalUserMessageFailed,
  removeLocalUserMessage,
  initialChatStreamState,
  selectChatMessages,
  type ChatMessage,
  type ChatStreamDeps,
  type ChatStreamState,
} from "@/lib/chat/stream-state";
import type { AgentEvent } from "@/lib/agents/types";

function makeDeps(): ChatStreamDeps {
  let n = 0;
  return { mintId: (prefix) => `${prefix}_${n++}`, now: () => 1000 };
}

/** Apply a sequence of events, returning the final state. */
function run(
  events: AgentEvent[],
  start: ChatStreamState = initialChatStreamState(),
  deps: ChatStreamDeps = makeDeps(),
): ChatStreamState {
  let state = start;
  for (const e of events) {
    state = applyAgentEvent(state, e, deps).state;
  }
  return state;
}

const thinking: AgentEvent = { type: "agent-status", status: "thinking" };
const complete: AgentEvent = { type: "agent-complete", stopReason: "end_turn" };
const thought = (text: string): AgentEvent => ({ type: "agent-text", text, isThought: true });
const text = (t: string): AgentEvent => ({ type: "agent-text", text: t });
const toolCall = (id: string): AgentEvent => ({
  type: "agent-tool-call", toolCallId: id, toolId: null, rawTitle: "ToolSearch", args: {},
});
const toolResult = (id: string): AgentEvent => ({
  type: "agent-tool-result", toolCallId: id, toolId: null, rawTitle: "ToolSearch", result: "ok", success: true,
});

describe("stream-state: turn assembly", () => {
  it("merges consecutive same-type chunks into one part", () => {
    const state = run([
      thinking,
      thought("The tools are loaded. Let me diagnose the MCP to see"),
      thought(" if it's working, and search for Lisa BLACKP"),
      thought("INK video."),
      text("Let me "),
      text("diagnose."),
    ]);
    const msgs = selectChatMessages(state);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].parts).toEqual([
      {
        type: "thought",
        text: "The tools are loaded. Let me diagnose the MCP to see if it's working, and search for Lisa BLACKPINK video.",
      },
      { type: "text", text: "Let me diagnose." },
    ]);
  });

  it("keeps the whole turn in ONE message across thoughts, text, and tool calls", () => {
    const state = run([
      thinking,
      thought("first thought"),
      text("intro"),
      toolCall("tc-1"),
      toolResult("tc-1"),
      thought("second "),
      thought("thought"),
      text("final reply"),
      complete,
    ]);
    const msgs = selectChatMessages(state);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].parts.map((p) => p.type)).toEqual([
      "thought", "text", "tool-call", "tool-result", "thought", "text",
    ]);
    expect(state.currentAgentMessageId).toBeNull();
  });

  it("agent-complete finalizes EVERY live message (none stuck streaming)", () => {
    // Two stray streaming messages (e.g. a turn whose complete was lost)
    const deps = makeDeps();
    let state = run([thinking, thought("a")], initialChatStreamState(), deps);
    state = run([thinking, thought("b"), complete], state, deps);
    for (const m of selectChatMessages(state)) {
      expect(m.isStreaming ?? false).toBe(false);
    }
  });

  it("a new thinking status finalizes the previous turn's message", () => {
    const deps = makeDeps();
    const state = run([thinking, thought("a"), thinking, thought("b")], initialChatStreamState(), deps);
    const msgs = selectChatMessages(state);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].isStreaming).toBe(false);
    expect(msgs[1].isStreaming).toBe(true);
  });
});

describe("stream-state: mid-turn adoption (refresh / session switch-back)", () => {
  const inFlight: ChatMessage = {
    id: "agent_server_7",
    role: "agent",
    // The snapshot ends mid-thought — the live tail must CONTINUE that
    // part, not open a second "thinking" section.
    parts: [
      { type: "tool-call", toolCallId: "tc-9", toolId: null, rawTitle: "Read", args: {} },
      { type: "thought", text: "head of the thought" },
    ],
    timestamp: 500,
  };
  const history: ChatMessage[] = [
    { id: "user_server_6", role: "user", parts: [{ type: "text", text: "hi" }], timestamp: 400 },
    inFlight,
  ];

  it("adopts the last cached agent message when stream content arrives with no current message", () => {
    let state = applyHistory(initialChatStreamState(), history);
    state = run([thought(" and the tail"), text("done")], state);

    const msgs = selectChatMessages(state);
    // user + the ONE in-flight agent message — no split head/tail
    expect(msgs.map((m) => m.id)).toEqual(["user_server_6", "agent_server_7"]);
    const adopted = msgs[1];
    expect(adopted.isStreaming).toBe(true);
    expect(adopted.parts).toEqual([
      { type: "tool-call", toolCallId: "tc-9", toolId: null, rawTitle: "Read", args: {} },
      { type: "thought", text: "head of the thought and the tail" },
      { type: "text", text: "done" },
    ]);
  });

  it("applyHistory replaces a racing live tail with the server snapshot", () => {
    // Events arrived BEFORE the history fetch resolved → a fallback live
    // message exists; the server snapshot then supersedes it.
    let state = run([thought("head of the thought")]); // no cached yet → minted fallback
    expect(state.live).toHaveLength(1);
    state = applyHistory(state, history);
    state = run([text("done")], state);

    const msgs = selectChatMessages(state);
    expect(msgs.map((m) => m.id)).toEqual(["user_server_6", "agent_server_7"]);
    expect(msgs[1].parts.map((p) => p.type)).toEqual(["tool-call", "thought", "text"]);
  });

  it("does NOT adopt when the last cached message is from the user", () => {
    const state0 = applyHistory(initialChatStreamState(), [history[0]]);
    const state = run([thought("fresh")], state0);
    const msgs = selectChatMessages(state);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].role).toBe("agent");
    expect(msgs[1].id).not.toBe("user_server_6");
  });

  it("does NOT re-adopt a stale finalized cached message after a later turn completes", () => {
    // Regression for a stress-test crash: aggressive mid-stream reloads left a
    // mount whose `cached` ended in a finalized agent turn. Sending a NEW
    // prompt, letting it complete, then receiving one stray late chunk made
    // adoption reach back and grab that OLD cached agent message — rendering
    // it twice (two children with the same React key).
    const deps = makeDeps();
    // Prior finished turn already in history.
    let state = applyHistory(initialChatStreamState(), [
      { id: "user_old", role: "user", parts: [{ type: "text", text: "q1" }], timestamp: 1 },
      { id: "agent_old", role: "agent", parts: [{ type: "text", text: "answer one" }], timestamp: 2 },
    ]);
    // A brand-new turn in this same mount: user prompt → think → reply → done.
    state = appendLocalUserMessage(state, {
      id: "msg_local", role: "user", parts: [{ type: "text", text: "q2" }], timestamp: 3,
    });
    state = run([thinking, thought("pondering"), text("answer two"), complete], state, deps);
    // A stray late chunk arrives AFTER the turn finished (currentId is null).
    state = run([text(" trailing bit")], state, deps);

    const msgs = selectChatMessages(state);
    const ids = msgs.map((m) => m.id);
    // No id may appear twice — that's the duplicate-key crash.
    expect(new Set(ids).size).toBe(ids.length);
    // The stale historical turn must NOT have been resurrected into live.
    expect(msgs.filter((m) => m.id === "agent_old")).toHaveLength(1);
    expect(msgs.find((m) => m.id === "agent_old")!.parts).toEqual([
      { type: "text", text: "answer one" },
    ]);
  });

  it("selectChatMessages never yields duplicate ids even if a stale dup slips into a bucket", () => {
    // Defensive guarantee: whatever upstream does, the render list is unique
    // by id (mismatched parts → live wins as the freshest copy).
    const dupId = "agent_dup";
    const state: ChatStreamState = {
      cached: [
        { id: "user_a", role: "user", parts: [{ type: "text", text: "hi" }], timestamp: 1 },
        { id: dupId, role: "agent", parts: [{ type: "text", text: "stale 23 parts" }], timestamp: 2 },
      ],
      live: [
        { id: "msg_b", role: "user", parts: [{ type: "text", text: "next" }], timestamp: 3 },
        { id: dupId, role: "agent", parts: [{ type: "text", text: "fresh copy" }], timestamp: 2, isStreaming: false },
      ],
      currentAgentMessageId: null,
    };
    const msgs = selectChatMessages(state);
    const ids = msgs.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(msgs.filter((m) => m.id === dupId)).toHaveLength(1);
    // live copy wins (it carries the in-flight/most-recent state)
    expect(msgs.find((m) => m.id === dupId)!.parts).toEqual([
      { type: "text", text: "fresh copy" },
    ]);
  });

  it("tool results pair with calls that live in cached history", () => {
    let state = applyHistory(initialChatStreamState(), history);
    const result = applyAgentEvent(state, {
      type: "agent-tool-result", toolCallId: "tc-9", toolId: null, rawTitle: "Read", result: "file contents", success: true,
    }, makeDeps());
    state = result.state;
    expect(result.toolResult).toBeTruthy();
    const msg = selectChatMessages(state).find((m) => m.id === "agent_server_7")!;
    expect(msg.parts.some((p) => p.type === "tool-result" && p.toolCallId === "tc-9")).toBe(true);
    // duplicate delivery is idempotent
    const again = applyAgentEvent(state, {
      type: "agent-tool-result", toolCallId: "tc-9", toolId: null, rawTitle: "Read", result: "file contents", success: true,
    }, makeDeps());
    expect(again.state).toBe(state);
  });
});

describe("stream-state: patches and notes", () => {
  it("chat-note is idempotent on noteId", () => {
    const note: AgentEvent = { type: "chat-note", text: "[manual edit] moved box", noteId: "note-1" };
    const state = run([note, note]);
    expect(selectChatMessages(state)).toHaveLength(1);
    expect(selectChatMessages(state)[0].isStreaming).toBe(false);
  });

  it("permission request appends to the current turn and resolves in place", () => {
    const deps = makeDeps();
    let state = run([thinking, text("about to generate")], initialChatStreamState(), deps);
    state = run([
      {
        type: "agent-permission-request",
        pendingId: "p-1",
        toolCall: { toolCallId: "tc-1" } as never,
        options: [],
        reason: "generation",
      },
    ], state, deps);
    let msgs = selectChatMessages(state);
    expect(msgs).toHaveLength(1);

    state = run([
      { type: "agent-permission-resolved", pendingId: "p-1", outcome: { kind: "selected", optionId: "allow" } },
    ], state, deps);
    msgs = selectChatMessages(state);
    const part = msgs[0].parts.find((p) => p.type === "permission-request");
    expect(part).toMatchObject({ status: "resolved", outcome: { kind: "selected", optionId: "allow" } });
  });

  it("tool progress patches the matching call wherever it lives", () => {
    const deps = makeDeps();
    let state = run([thinking, toolCall("tc-1")], initialChatStreamState(), deps);
    state = run([
      { type: "agent-tool-progress", toolCallId: "tc-1", toolId: null, rawTitle: "ToolSearch", text: "60/100", jobId: "job-1" },
    ], state, deps);
    const part = selectChatMessages(state)[0].parts[0];
    expect(part).toMatchObject({ type: "tool-call", progress: "60/100", jobId: "job-1" });
  });

  it("identical progress is identity-preserving (no re-render churn)", () => {
    const deps = makeDeps();
    const progress: AgentEvent = {
      type: "agent-tool-progress", toolCallId: "tc-1", toolId: null, rawTitle: "ToolSearch", text: "60/100",
    };
    const state = run([thinking, toolCall("tc-1"), progress], initialChatStreamState(), deps);
    expect(applyAgentEvent(state, progress, deps).state).toBe(state);
  });
});

describe("stream-state: local user echo + merge", () => {
  it("user message appends and history merge dedups by id (live wins)", () => {
    let state = initialChatStreamState();
    state = appendLocalUserMessage(state, {
      id: "msg_0", role: "user", parts: [{ type: "text", text: "hello" }], timestamp: 1,
    });
    state = applyHistory(state, [
      { id: "old_1", role: "agent", parts: [{ type: "text", text: "earlier" }], timestamp: 0 },
    ]);
    // Hmm — last cached is agent + no streaming live → plain install
    expect(selectChatMessages(state).map((m) => m.id)).toEqual(["old_1", "msg_0"]);
  });

  it("hides system-context messages", () => {
    const state = applyHistory(initialChatStreamState(), [
      { id: "sys", role: "user", parts: [{ type: "text", text: "ctx" }], timestamp: 0, isSystemContext: true },
      { id: "u1", role: "user", parts: [{ type: "text", text: "real" }], timestamp: 1 },
    ]);
    expect(selectChatMessages(state).map((m) => m.id)).toEqual(["u1"]);
  });
});

describe("stream-state: send failure (optimistic message rollback)", () => {
  const userMsg = (id: string): ChatMessage => ({
    id, role: "user", parts: [{ type: "text", text: "hello" }], timestamp: 1,
  });

  it("markLocalUserMessageFailed flags the live user message", () => {
    let state = appendLocalUserMessage(initialChatStreamState(), userMsg("msg_0"));
    state = markLocalUserMessageFailed(state, "msg_0");
    const msg = selectChatMessages(state)[0];
    expect(msg.sendFailed).toBe(true);
  });

  it("markLocalUserMessageFailed is identity-preserving for unknown ids", () => {
    const state = appendLocalUserMessage(initialChatStreamState(), userMsg("msg_0"));
    expect(markLocalUserMessageFailed(state, "nope")).toBe(state);
  });

  it("removeLocalUserMessage drops the message from live", () => {
    let state = appendLocalUserMessage(initialChatStreamState(), userMsg("msg_0"));
    state = appendLocalUserMessage(state, userMsg("msg_1"));
    state = removeLocalUserMessage(state, "msg_0");
    expect(selectChatMessages(state).map((m) => m.id)).toEqual(["msg_1"]);
  });

  it("a failed flag survives a history refetch (server never saw the message)", () => {
    let state = appendLocalUserMessage(initialChatStreamState(), userMsg("msg_0"));
    state = markLocalUserMessageFailed(state, "msg_0");
    state = applyHistory(state, [
      { id: "old_1", role: "agent", parts: [{ type: "text", text: "earlier" }], timestamp: 0 },
    ]);
    const msg = selectChatMessages(state).find((m) => m.id === "msg_0");
    expect(msg?.sendFailed).toBe(true);
  });
});

describe("tool-call lifecycle (client)", () => {
  it("appendToolCall starts pending; agent-tool-status flips to running", () => {
    const deps = makeDeps();
    let s = initialChatStreamState();
    s = applyAgentEvent(s, { type: "agent-status", status: "thinking" }, deps).state;
    s = applyAgentEvent(
      s,
      { type: "agent-tool-call", toolCallId: "tc-1", toolId: null, rawTitle: "T", args: {} },
      deps,
    ).state;
    const call = () =>
      s.live
        .flatMap((m) => m.parts)
        .find((p) => p.type === "tool-call" && p.toolCallId === "tc-1") as {
        status?: string;
        runningAt?: number;
      };
    expect(call().status).toBe("pending");
    s = applyAgentEvent(
      s,
      { type: "agent-tool-status", toolCallId: "tc-1", status: "running", runningAt: 123456 },
      deps,
    ).state;
    expect(call().status).toBe("running");
    expect(call().runningAt).toBe(123456);
    // Idempotent re-delivery: a second status event (SSE re-fan, different
    // runningAt) must not churn the timer baseline — identity-preserving.
    const before = s;
    s = applyAgentEvent(
      s,
      { type: "agent-tool-status", toolCallId: "tc-1", status: "running", runningAt: 999999 },
      deps,
    ).state;
    expect(call().runningAt).toBe(123456);
    expect(s).toBe(before);
  });

  it("agent-tool-result stamps completedAt on the result and clears the call status", () => {
    const deps = makeDeps();
    let s = initialChatStreamState();
    s = applyAgentEvent(s, { type: "agent-status", status: "thinking" }, deps).state;
    s = applyAgentEvent(
      s,
      { type: "agent-tool-call", toolCallId: "tc-1", toolId: null, rawTitle: "T", args: {} },
      deps,
    ).state;
    s = applyAgentEvent(
      s,
      { type: "agent-tool-result", toolCallId: "tc-1", toolId: null, rawTitle: "T", result: "ok", success: true },
      deps,
    ).state;
    const parts = s.live.flatMap((m) => m.parts);
    const result = parts.find(
      (p) => p.type === "tool-result" && p.toolCallId === "tc-1",
    ) as { completedAt?: number };
    expect(result.completedAt).toBeTypeOf("number");
    const call = parts.find(
      (p) => p.type === "tool-call" && p.toolCallId === "tc-1",
    ) as { status?: string };
    expect(call.status).toBeUndefined();
  });
});
