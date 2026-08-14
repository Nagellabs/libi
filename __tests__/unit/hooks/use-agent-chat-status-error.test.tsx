// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * `agent-status` has carried an optional `error` string since it was
 * introduced, and the hook read only `data.status` (use-agent-chat.ts:677-683).
 * `status === "error"` had no visual treatment anywhere either — chat-panel.tsx
 * uses `chat.status` solely to decide whether to render a "connecting"
 * skeleton. So an agent that told us exactly what went wrong produced a chat
 * that looked merely idle.
 */

class MockEventSource {
  /** The most recently constructed instance — the one the hook is wired to. */
  static live: MockEventSource | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  close = vi.fn();
  constructor(_url: string) {
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

describe("useAgentChat — agent-status error text", () => {
  beforeEach(() => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ messages: [] }), { status: 200 }),
    );
  });

  it("renders the agent's error as a chat message instead of dropping it", async () => {
    const { result } = renderHook(() => useAgentChat("session-err-1"));

    emit({
      type: "agent-status",
      status: "error",
      error: "Authentication required — run `codex login` to sign in.",
      sessionId: "session-err-1",
    });

    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    const [msg] = result.current.messages;
    expect(msg.parts).toEqual([
      {
        type: "text",
        text: "Authentication required — run `codex login` to sign in.",
      },
    ]);
    expect(msg.isStreaming).toBe(false);
    expect(result.current.status).toBe("error");
    expect(result.current.statusError).toBe(
      "Authentication required — run `codex login` to sign in.",
    );
  });

  it("is idempotent across duplicate SSE delivery (reconnect re-fan)", async () => {
    const { result } = renderHook(() => useAgentChat("session-err-2"));
    const payload = {
      type: "agent-status",
      status: "error",
      error: "Authentication required",
      sessionId: "session-err-2",
    };

    emit(payload);
    emit(payload);

    await waitFor(() => expect(result.current.messages).toHaveLength(1));
  });

  it("posts nothing when the status carries no error text", async () => {
    const { result } = renderHook(() => useAgentChat("session-err-3"));

    emit({ type: "agent-status", status: "error", sessionId: "session-err-3" });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.statusError).toBeNull();
  });
});
