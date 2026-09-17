import { describe, it, expect } from "vitest";
import {
  applyAgentEvent,
  initialChatStreamState,
  selectChatMessages,
  type ChatStreamDeps,
  type ChatStreamState,
} from "@/lib/chat/stream-state";
import type { AgentEvent } from "@/lib/agents/types";

/**
 * claude-agent-acp emits `tool_call` at content_block_start — BEFORE the
 * tool's input has finished streaming — so the arguments are `{}` there and
 * the real ones only ever arrive on a later `tool_call_update`.
 *
 * A previous fix addressed the transcript: the message cache adopts the late input,
 * so a page refresh shows it. The LIVE view was untouched — there was no event
 * carrying the update and no reducer case for one — so a user watching a
 * session saw every tool call with empty arguments for its whole duration.
 * `agent-tool-args` is that event; this is its reducer.
 */

function makeDeps(): ChatStreamDeps {
  let n = 0;
  return { mintId: (prefix) => `${prefix}_${n++}`, now: () => 1000 };
}

function run(events: AgentEvent[]): ChatStreamState {
  const deps = makeDeps();
  let state = initialChatStreamState();
  for (const e of events) state = applyAgentEvent(state, e, deps).state;
  return state;
}

const thinking: AgentEvent = { type: "agent-status", status: "thinking" };
const call = (id: string, args: unknown = {}): AgentEvent => ({
  type: "agent-tool-call",
  toolCallId: id,
  toolId: null,
  rawTitle: "Bash",
  args,
});
const argsEvent = (id: string, args: unknown): AgentEvent => ({
  type: "agent-tool-args",
  toolCallId: id,
  args,
});

/** The single tool-call part in the (only) agent message. */
function toolArgs(state: ChatStreamState, id: string): unknown {
  for (const msg of selectChatMessages(state)) {
    for (const part of msg.parts) {
      if (part.type === "tool-call" && part.toolCallId === id) return part.args;
    }
  }
  return undefined;
}

describe("stream-state: agent-tool-args", () => {
  it("fills in the arguments the tool call was created without", () => {
    const before = run([thinking, call("tc-1")]);
    // The defect, in one assertion: this is what the live row rendered for the
    // entire call.
    expect(toolArgs(before, "tc-1")).toEqual({});

    const after = run([
      thinking,
      call("tc-1"),
      argsEvent("tc-1", { command: "npm test", description: "Run the suite" }),
    ]);
    expect(toolArgs(after, "tc-1")).toEqual({
      command: "npm test",
      description: "Run the suite",
    });
  });

  it("is monotone: a fuller input replaces a partial one", () => {
    // The input JSON is still streaming while the tool runs, so an in-flight
    // update can carry only some of the keys.
    const state = run([
      thinking,
      call("tc-1"),
      argsEvent("tc-1", { command: "npm te" }),
      argsEvent("tc-1", { command: "npm test", description: "Run the suite" }),
    ]);
    expect(toolArgs(state, "tc-1")).toEqual({
      command: "npm test",
      description: "Run the suite",
    });
  });

  it("never removes what it already has", () => {
    const full = { command: "npm test", description: "Run the suite" };
    // SSE delivery is not ordered after a reconnect, so a stale, smaller
    // payload can arrive last. It must not win.
    const state = run([
      thinking,
      call("tc-1"),
      argsEvent("tc-1", full),
      argsEvent("tc-1", { command: "npm te" }),
      argsEvent("tc-1", {}),
      argsEvent("tc-1", null),
    ]);
    expect(toolArgs(state, "tc-1")).toEqual(full);
  });

  it("only patches the call it names", () => {
    const state = run([
      thinking,
      call("tc-1"),
      call("tc-2"),
      argsEvent("tc-2", { pattern: "libi.*" }),
    ]);
    expect(toolArgs(state, "tc-1")).toEqual({});
    expect(toolArgs(state, "tc-2")).toEqual({ pattern: "libi.*" });
  });

  it("is a no-op for a tool call this client never saw", () => {
    const state = run([thinking, call("tc-1"), argsEvent("tc-unknown", { a: 1 })]);
    expect(toolArgs(state, "tc-1")).toEqual({});
  });
});
