import { describe, it, expect } from "vitest";
import {
  applyAgentEvent,
  applyHistory,
  initialChatStreamState,
  selectChatMessages,
  type ChatStreamDeps,
  type ChatStreamState,
} from "@/lib/chat/stream-state";
import type { AgentEvent } from "@/lib/agents/types";

/**
 * The live half of the Write/Edit title refinement: the server replaces the
 * placeholder "Preparing file…" in its cache and emits `agent-tool-title`; the
 * reducer must patch the row the user is watching the same way — including a
 * row that moved into `cached` because the page was refreshed mid-call.
 */

function makeDeps(): ChatStreamDeps {
  let n = 0;
  return { mintId: (prefix) => `${prefix}_${n++}`, now: () => 1000 };
}

function run(events: AgentEvent[], start: ChatStreamState = initialChatStreamState()): ChatStreamState {
  const deps = makeDeps();
  let state = start;
  for (const e of events) state = applyAgentEvent(state, e, deps).state;
  return state;
}

function titleOf(state: ChatStreamState, id: string): string | undefined {
  for (const msg of selectChatMessages(state)) {
    for (const part of msg.parts) {
      if (part.type === "tool-call" && part.toolCallId === id) return part.rawTitle;
    }
  }
  return undefined;
}

const thinking: AgentEvent = { type: "agent-status", status: "thinking" };
const writeCall: AgentEvent = {
  type: "agent-tool-call",
  toolCallId: "w1",
  toolId: null,
  rawTitle: "Preparing file…",
  args: {},
};
const titleEvent = (rawTitle: string): AgentEvent => ({ type: "agent-tool-title", toolCallId: "w1", rawTitle });

describe("stream-state: agent-tool-title", () => {
  it("replaces the live row's placeholder title", () => {
    const state = run([thinking, writeCall, titleEvent("Write graphics/g1.js")]);
    expect(titleOf(state, "w1")).toBe("Write graphics/g1.js");
  });

  it("patches a row that lives in the refreshed history, not only the live tail", () => {
    const history = applyHistory(initialChatStreamState(), [
      {
        id: "agent_1",
        role: "agent",
        timestamp: 1,
        parts: [{ type: "tool-call", toolCallId: "w1", toolId: null, rawTitle: "Preparing file…", args: {} }],
      },
    ]);
    const state = run([titleEvent("Write a.txt")], history);
    expect(titleOf(state, "w1")).toBe("Write a.txt");
  });

  it("ignores an empty title and an unknown call", () => {
    const base = run([thinking, writeCall]);
    expect(titleOf(run([titleEvent("")], base), "w1")).toBe("Preparing file…");
    const other: AgentEvent = { type: "agent-tool-title", toolCallId: "nope", rawTitle: "Write x" };
    expect(run([other], base)).toBe(base);
  });
});
