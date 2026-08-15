// @vitest-environment jsdom
/**
 * Reproduces the "thinking UI glitch": during a live turn that mixes
 * thought chunks, text chunks, and tool calls, every part must land on
 * ONE agent message, and consecutive same-type chunks must merge into a
 * single part. The reported symptom (multiple fragmented "thinking"
 * sections, stuck-expanded with pulsing dots after the turn completes)
 * happens when chunks fragment across parts/messages.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StrictMode, type ReactNode } from "react";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useAgentChat } from "@/hooks/sessions/use-agent-chat";
import { loadDraft } from "@/lib/chat/draft-store";

const SESSION = "sess-test-1";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

function lastES(): FakeEventSource {
  const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  if (!es) throw new Error("no EventSource created");
  return es;
}

function emit(event: Record<string, unknown>) {
  lastES().onmessage?.({
    data: JSON.stringify({ sessionId: SESSION, ...event }),
  });
}

beforeEach(() => {
  // Failed sends back their text up into the per-session draft store —
  // start every test with a clean slate so backups can't leak across tests.
  window.sessionStorage.clear();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ messages: [] }),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Drives the exact event sequence observed in the broken session:
 *  thinking → thought chunks → text → tool call+result → MORE thought
 *  chunks → text → two tool calls → results → final text → complete. */
function driveTurn() {
  // Turn starts
  act(() => emit({ type: "agent-status", status: "thinking" }));

  // First thinking block — streamed in small chunks
  act(() => emit({ type: "agent-text", isThought: true, text: "I'll check the YouTube Downloader MCP status " }));
  act(() => emit({ type: "agent-text", isThought: true, text: "and search for the video. " }));
  act(() => emit({ type: "agent-text", isThought: true, text: "Let me load the needed tools first." }));

  // Visible text before the first tool call
  act(() => emit({ type: "agent-text", text: "Loading tools." }));

  // First tool call + its result
  act(() =>
    emit({
      type: "agent-tool-call",
      toolCallId: "tc-1",
      toolId: null,
      rawTitle: "ToolSearch",
      args: { query: "diagnose" },
    }),
  );
  act(() =>
    emit({
      type: "agent-tool-result",
      toolCallId: "tc-1",
      toolId: null,
      rawTitle: "ToolSearch",
      result: "3 items",
      success: true,
    }),
  );

  // Second thinking block — burst of chunks (delivered between renders,
  // like a real SSE burst)
  act(() => {
    emit({ type: "agent-text", isThought: true, text: "The tools are loaded. Let me first diagnose the YouTube Downloader MCP to see" });
    emit({ type: "agent-text", isThought: true, text: " if it's working, and simultaneously search for Lisa BLACKP" });
    emit({ type: "agent-text", isThought: true, text: "INK video." });
  });

  // Visible text + two parallel tool calls
  act(() => emit({ type: "agent-text", text: "Let me diagnose the YouTube Downloader and search for the video at the same time." }));
  act(() =>
    emit({
      type: "agent-tool-call",
      toolCallId: "tc-2",
      toolId: "libi:diagnose_mcp",
      rawTitle: "mcp__libi__libi_diagnose_mcp",
      args: {},
    }),
  );
  act(() =>
    emit({
      type: "agent-tool-call",
      toolCallId: "tc-3",
      toolId: "YouTube Downloader:ytdlp_search_videos",
      rawTitle: "mcp__YouTube_Downloader__ytdlp_search_videos",
      args: { query: "lisa blackpink" },
    }),
  );
  act(() =>
    emit({
      type: "agent-tool-result",
      toolCallId: "tc-2",
      toolId: "libi:diagnose_mcp",
      rawTitle: "mcp__libi__libi_diagnose_mcp",
      result: "ok",
      success: true,
    }),
  );
  act(() =>
    emit({
      type: "agent-tool-result",
      toolCallId: "tc-3",
      toolId: "YouTube Downloader:ytdlp_search_videos",
      rawTitle: "mcp__YouTube_Downloader__ytdlp_search_videos",
      result: "5 videos",
      success: true,
    }),
  );

  // Final reply text
  act(() => emit({ type: "agent-text", text: "The YouTube Downloader is healthy. Here are the top results." }));

  // Turn ends
  act(() => emit({ type: "agent-complete", stopReason: "end_turn" }));
}

function runAssertions(result: { current: ReturnType<typeof useAgentChat> }) {
  const agentMessages = result.current.messages.filter((m) => m.role === "agent");

  // The whole turn is ONE agent message
  expect(agentMessages).toHaveLength(1);
  const msg = agentMessages[0];

  // Consecutive same-type chunks merged: exactly two thought parts
  const thoughtParts = msg.parts.filter((p) => p.type === "thought");
  expect(thoughtParts.map((p) => (p as { text: string }).text)).toEqual([
    "I'll check the YouTube Downloader MCP status and search for the video. Let me load the needed tools first.",
    "The tools are loaded. Let me first diagnose the YouTube Downloader MCP to see if it's working, and simultaneously search for Lisa BLACKPINK video.",
  ]);

  // Part shape: thought, text, tool-call, tool-result, thought, text,
  // tool-call ×2, tool-result ×2, text
  expect(msg.parts.map((p) => p.type)).toEqual([
    "thought",
    "text",
    "tool-call",
    "tool-result",
    "thought",
    "text",
    "tool-call",
    "tool-call",
    "tool-result",
    "tool-result",
    "text",
  ]);

  // After agent-complete, NOTHING is left streaming (a stuck
  // isStreaming=true keeps ThoughtSections expanded with pulsing dots)
  for (const m of result.current.messages) {
    expect(m.isStreaming ?? false).toBe(false);
  }
}

describe("useAgentChat live stream assembly", () => {
  it("assembles one agent message with merged thought parts (plain)", async () => {
    const { result } = renderHook(() => useAgentChat(SESSION));
    await act(async () => {}); // let the history fetch settle
    driveTurn();
    runAssertions(result);
  });

  it("assembles one agent message with merged thought parts (StrictMode, mirrors dev)", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );
    const { result } = renderHook(() => useAgentChat(SESSION), { wrapper });
    await act(async () => {});
    driveTurn();
    runAssertions(result);
  });
});

describe("useAgentChat send failure", () => {
  /** fetch stub where POST /api/agent/send fails (rejects or non-OK) a set
   *  number of times before succeeding; everything else (history GET) is OK. */
  function stubSendFailures(failures: number, mode: "reject" | "http500") {
    const sendCalls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { body?: string }) => {
        const u = String(url);
        if (u.includes("/api/agent/send")) {
          sendCalls.push({ url: u, body: init?.body ? JSON.parse(init.body) : null });
          if (sendCalls.length <= failures) {
            if (mode === "reject") throw new TypeError("Failed to fetch");
            return { ok: false, status: 500, json: async () => ({}) };
          }
          return { ok: true, json: async () => ({}) };
        }
        return { ok: true, json: async () => ({ messages: [] }) };
      }),
    );
    return sendCalls;
  }

  it("network-rejected send resets status and flags the optimistic message", async () => {
    stubSendFailures(99, "reject");
    const { result } = renderHook(() => useAgentChat(SESSION));
    await act(async () => {});

    await act(async () => {
      result.current.sendMessage("hello there");
    });

    // The stuck-"generating" bug: status must NOT stay "thinking".
    expect(result.current.status).toBe("connected");
    expect(result.current.isLoading).toBe(false);

    const user = result.current.messages.find((m) => m.role === "user");
    expect(user).toBeDefined();
    expect(user?.sendFailed).toBe(true);
  });

  it("HTTP-error send is handled identically to a network rejection", async () => {
    stubSendFailures(99, "http500");
    const { result } = renderHook(() => useAgentChat(SESSION));
    await act(async () => {});

    await act(async () => {
      result.current.sendMessage("hello there");
    });

    expect(result.current.status).toBe("connected");
    expect(result.current.messages.find((m) => m.role === "user")?.sendFailed).toBe(true);
  });

  it("retryMessage removes the failed copy and re-sends the same content", async () => {
    const sendCalls = stubSendFailures(1, "reject");
    const { result } = renderHook(() => useAgentChat(SESSION));
    await act(async () => {});

    await act(async () => {
      result.current.sendMessage("retry me");
    });
    const failed = result.current.messages.find((m) => m.role === "user");
    expect(failed?.sendFailed).toBe(true);

    await act(async () => {
      result.current.retryMessage(failed!.id);
    });

    // Exactly one user message remains, no longer flagged.
    const users = result.current.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0].sendFailed ?? false).toBe(false);
    // Both POSTs carried the same prompt text.
    expect(sendCalls).toHaveLength(2);
    expect((sendCalls[1].body as { text: string }).text).toBe("retry me");
    // Second send is in flight normally.
    expect(result.current.status).toBe("thinking");
  });

  it("backs up a failed send's text so a reload can restore it, and clears the backup once the retry delivers", async () => {
    stubSendFailures(1, "http500");
    const { result } = renderHook(() => useAgentChat(SESSION));
    await act(async () => {});

    await act(async () => {
      result.current.sendMessage("precious words");
    });

    // The sendFailed bubble lives only in client memory; the draft store is
    // what survives a reload.
    expect(loadDraft(SESSION)).toBe("precious words");

    const failed = result.current.messages.find((m) => m.role === "user");
    await act(async () => {
      result.current.retryMessage(failed!.id);
    });

    // Delivered — the backup must not resurface in the composer later.
    expect(loadDraft(SESSION)).toBe("");
  });
});
