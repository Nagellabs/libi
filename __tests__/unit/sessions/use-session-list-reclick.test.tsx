// @vitest-environment jsdom
/**
 * Sidebar recovery path for the agent-switch stranding bug: clicking the
 * ALREADY-selected session used to be a pure client-side no-op (same-value
 * setState fires no effects), so a user staring at a server-side-deactivated
 * session had no way to revive it short of a full page reload. A re-click now
 * pokes GET /api/agent/messages — the endpoint whose handler runs
 * `activateSession` (warm-cache no-op when the session is genuinely active).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useSessionList } from "@/hooks/sessions/use-session-list";

class FakeEventSource {
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  close() {}
}

let fetchCalls: string[];

beforeEach(() => {
  fetchCalls = [];
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      fetchCalls.push(String(url));
      return {
        ok: true,
        json: async () => ({ sessions: [], messages: [] }),
      };
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useSessionList switchSession re-click", () => {
  it("selects a session without touching the messages endpoint (chat panel owns activation)", async () => {
    const { result } = renderHook(() => useSessionList());
    await act(async () => {});

    act(() => result.current.switchSession("s1"));

    expect(result.current.activeSessionId).toBe("s1");
    expect(fetchCalls.some((u) => u.includes("/api/agent/messages"))).toBe(false);
  });

  it("re-clicking the selected session triggers server-side activation via the messages endpoint", async () => {
    const { result } = renderHook(() => useSessionList());
    await act(async () => {});

    act(() => result.current.switchSession("s1"));
    await act(async () => {});
    act(() => result.current.switchSession("s1")); // ← the former no-op
    await act(async () => {});

    const activations = fetchCalls.filter((u) =>
      u.includes("/api/agent/messages?sessionId=s1"),
    );
    expect(activations).toHaveLength(1);
    // Still the selected session — the re-click never deselects.
    expect(result.current.activeSessionId).toBe("s1");
  });
});
