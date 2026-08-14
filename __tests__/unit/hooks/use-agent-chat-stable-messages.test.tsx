// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// EventSource is not available in jsdom — stub it before the hook module
// loads so the module-level singleton initialisation succeeds.
class MockEventSource {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  close = vi.fn();
  constructor(_url: string) {}
}
vi.stubGlobal("EventSource", MockEventSource);

const { useAgentChat } = await import("@/hooks/sessions/use-agent-chat");

describe("useAgentChat — messages referential stability (regression)", () => {
  // Regression for the chat-composer infinite render loop: chat.messages was
  // rebuilt as a new array reference on every render via
  // `[...cached, ...live].filter(...)`, which busted referential equality for
  // the chat-panel scroll effect and pulled the whole tree into a
  // "Maximum update depth exceeded" cascade. With the useMemo fix the array
  // identity must stay stable across renders that didn't change either
  // underlying state slice.
  it("returns the same messages array reference across re-renders when state is unchanged", () => {
    const { result, rerender } = renderHook(() => useAgentChat("session-1"));

    const first = result.current.messages;
    rerender();
    const second = result.current.messages;
    rerender();
    const third = result.current.messages;

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("returns the same messages array reference for a null session across re-renders", () => {
    const { result, rerender } = renderHook(() => useAgentChat(null));

    const first = result.current.messages;
    rerender();
    rerender();
    const last = result.current.messages;

    expect(last).toBe(first);
  });
});
