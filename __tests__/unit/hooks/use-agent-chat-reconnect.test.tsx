// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * SES-1: the ONE global SSE connection drops and comes back. Stream events sent while it was down
 * are gone for good, so a chat that was mid-turn when it dropped would show a reply with a hole in
 * it until a reload. On `sse-reconnected` such a chat takes the server's history again (the same
 * `/api/agent/messages` + `applyHistory` a load uses); an idle chat has nothing to catch up on and
 * does not refetch.
 */

class MockEventSource {
  static live: MockEventSource | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  close = vi.fn();
  constructor() {
    MockEventSource.live = this;
  }
}
vi.stubGlobal("EventSource", MockEventSource);

const { useAgentChat } = await import("@/hooks/sessions/use-agent-chat");

function emit(payload: Record<string, unknown>) {
  act(() => {
    MockEventSource.live?.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  });
}

type Msg = { id: string; role: "user" | "agent"; parts: Array<{ type: "text"; text: string }>; timestamp: number };

/** What the server's message cache holds right now — the route answers from it. */
let serverHistory: Msg[] = [];
let historyCalls = 0;
beforeEach(() => {
  historyCalls = 0;
  serverHistory = [];
  vi.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("/api/agent/messages")) {
      historyCalls++;
      return new Response(JSON.stringify({ messages: serverHistory }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
});

/** The connection errors (nothing sent meanwhile reaches the page), comes back 3 s later, and opens. */
function drop(whileDown: () => void = () => {}) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    act(() => {
      MockEventSource.live?.onerror?.(new Event("error"));
    });
    whileDown();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
  } finally {
    vi.useRealTimers();
  }
  act(() => MockEventSource.live?.onopen?.(new Event("open")));
}

const text = (m: { parts: Array<{ type: string; text?: string }> }) =>
  m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

describe("useAgentChat — SSE reconnect (SES-1)", () => {
  it("a chat that was streaming shows the chunks sent while the connection was down", async () => {
    const sid = "reconnect-streaming";
    serverHistory = [{ id: "u1", role: "user", parts: [{ type: "text", text: "make a video" }], timestamp: 1 }];
    const { result } = renderHook(() => useAgentChat(sid));
    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(historyCalls).toBe(1);

    emit({ type: "agent-status", status: "thinking", sessionId: sid });
    emit({ type: "agent-text", text: "Hello ", sessionId: sid });
    serverHistory = [
      ...serverHistory,
      { id: "a1", role: "agent", parts: [{ type: "text", text: "Hello " }], timestamp: 2 },
    ];
    expect(result.current.status).toBe("streaming");

    drop(() => {
      // Three chunks the server sent while the page was not listening.
      serverHistory = [
        serverHistory[0],
        { id: "a1", role: "agent", parts: [{ type: "text", text: "Hello one two three" }], timestamp: 2 },
      ];
    });

    await waitFor(() => expect(historyCalls).toBe(2));
    await waitFor(() => expect(result.current.messages.map(text)).toEqual(["make a video", "Hello one two three"]));

    // The turn goes on: the next chunk continues that same reply, not a second bubble.
    emit({ type: "agent-status", status: "streaming", sessionId: sid });
    emit({ type: "agent-text", text: " four", sessionId: sid });
    expect(result.current.messages.map(text)).toEqual(["make a video", "Hello one two three four"]);
    expect(result.current.messages.filter((m) => m.role === "agent")).toHaveLength(1);
    expect(result.current.isLoading).toBe(true);
  });

  it("a turn that ENDED while the connection was down shows its whole reply, not streaming", async () => {
    const sid = "reconnect-ended";
    serverHistory = [{ id: "u1", role: "user", parts: [{ type: "text", text: "go" }], timestamp: 1 }];
    const { result } = renderHook(() => useAgentChat(sid));
    await waitFor(() => expect(result.current.status).toBe("connected"));

    emit({ type: "agent-status", status: "thinking", sessionId: sid });
    emit({ type: "agent-text", text: "Wor", sessionId: sid });

    drop(() => {
      serverHistory = [serverHistory[0], { id: "a1", role: "agent", parts: [{ type: "text", text: "Working. Done." }], timestamp: 2 }];
    });
    // What the server says of an idle chat on (re)connect.
    emit({ type: "agent-status", status: "connected", sessionId: sid });

    await waitFor(() => expect(result.current.messages.map(text)).toEqual(["go", "Working. Done."]));
    expect(result.current.messages.some((m) => m.isStreaming)).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });

  it("an idle chat does not refetch", async () => {
    const sid = "reconnect-idle";
    serverHistory = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }], timestamp: 1 },
      { id: "a1", role: "agent", parts: [{ type: "text", text: "hello" }], timestamp: 2 },
    ];
    const { result } = renderHook(() => useAgentChat(sid));
    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(historyCalls).toBe(1);

    drop();
    await new Promise((r) => setTimeout(r, 20));
    expect(historyCalls).toBe(1);
    expect(result.current.messages.map(text)).toEqual(["hi", "hello"]);
  });

  it("a failed refetch keeps what the chat shows", async () => {
    const sid = "reconnect-fetch-500";
    serverHistory = [{ id: "u1", role: "user", parts: [{ type: "text", text: "go" }], timestamp: 1 }];
    const { result } = renderHook(() => useAgentChat(sid));
    await waitFor(() => expect(result.current.status).toBe("connected"));
    emit({ type: "agent-status", status: "thinking", sessionId: sid });
    emit({ type: "agent-text", text: "partial", sessionId: sid });

    let failed = 0;
    vi.mocked(global.fetch).mockImplementation(async (input) => {
      if (String(input).startsWith("/api/agent/messages")) {
        failed++;
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      return new Response("{}", { status: 200 });
    });
    drop();
    await waitFor(() => expect(failed).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.messages.map(text)).toEqual(["go", "partial"]);
  });

  it("an approval card that arrives while the refetch is in flight survives it (review I3)", async () => {
    const sid = "reconnect-card";
    serverHistory = [{ id: "u1", role: "user", parts: [{ type: "text", text: "go" }], timestamp: 1 }];
    const { result } = renderHook(() => useAgentChat(sid));
    await waitFor(() => expect(result.current.status).toBe("connected"));
    emit({ type: "agent-status", status: "thinking", sessionId: sid });
    emit({ type: "agent-text", text: "Let me run it", sessionId: sid });

    // The history the refetch gets was serialized BEFORE the approval request below.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const snapshot = [
      serverHistory[0],
      { id: "a1", role: "agent" as const, parts: [{ type: "text" as const, text: "Let me run it" }], timestamp: 2 },
    ];
    vi.mocked(global.fetch).mockImplementation(async (input) => {
      if (String(input).startsWith("/api/agent/messages")) {
        historyCalls++;
        await gate;
        return new Response(JSON.stringify({ messages: snapshot }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    drop();
    await waitFor(() => expect(historyCalls).toBe(2));
    // It reaches the page over the new connection before the GET's response.
    emit({
      type: "agent-permission-request",
      pendingId: "p1",
      toolCall: { toolCallId: "t1", title: "Bash" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      reason: "acp",
      sessionId: sid,
    });
    release();
    await waitFor(() => expect(result.current.messages.at(-1)?.parts.map((p) => p.type)).toContain("permission-request"));
    const card = result.current.messages.flatMap((m) => m.parts).find((p) => p.type === "permission-request") as { pendingId: string; status: string };
    expect(card.pendingId).toBe("p1");
    expect(card.status).toBe("pending");
    expect(text(result.current.messages.at(-1)!)).toBe("Let me run it");
  });

  it("a chat note shown only here (never in the server's history) survives the refetch (review M3)", async () => {
    const sid = "reconnect-note";
    serverHistory = [{ id: "u1", role: "user", parts: [{ type: "text", text: "go" }], timestamp: 1 }];
    const { result } = renderHook(() => useAgentChat(sid));
    await waitFor(() => expect(result.current.status).toBe("connected"));
    emit({ type: "agent-status", status: "thinking", sessionId: sid });
    emit({ type: "chat-note", text: "You moved the title by hand.", noteId: "note-manual-1", sessionId: sid });
    serverHistory = [serverHistory[0], { id: "a1", role: "agent", parts: [{ type: "text", text: "Working" }], timestamp: 2 }];

    drop();
    await waitFor(() => expect(result.current.messages.map(text)).toContain("Working"));
    expect(result.current.messages.map(text)).toContain("You moved the title by hand.");
    expect(result.current.messages.filter((m) => text(m) === "You moved the title by hand.")).toHaveLength(1);
  });
});
