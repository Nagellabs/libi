import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTabNavGate, TAB_NAV_CLAIM_WAIT_MS, type TabNavChannel } from "@/hooks/sessions/tab-nav-gate";

/**
 * NAV-1 (full-verification F14): an agent's `libi.show({ target: "extension" })` / `libi.show({ target: "templates" })` reached
 * every open studio tab, and every tab navigated — including one the user had on another page. Now
 * the event names the chat it came from, and only the tab showing that chat obeys; with no tab
 * showing it (or no chat at all — a CLI agent), today's behaviour is kept.
 *
 * Two "tabs" here are two gates over one in-memory BroadcastChannel bus, as two browser tabs of the
 * studio are.
 */

function bus() {
  const members: TabNavChannel[] = [];
  const join = (): TabNavChannel => {
    const ch: TabNavChannel = {
      onmessage: null,
      postMessage(message) {
        // BroadcastChannel delivers to every OTHER member, asynchronously.
        for (const m of members) if (m !== ch) queueMicrotask(() => m.onmessage?.({ data: message }));
      },
    };
    members.push(ch);
    return ch;
  };
  return { join };
}

function tab(mounted: string[], channel: TabNavChannel | null) {
  const go = vi.fn();
  const gate = createTabNavGate({ isThisTabsChat: (id) => mounted.includes(id), channel });
  return { go, deliver: (event: Record<string, unknown>) => gate(event, go) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("tab navigation gate", () => {
  it("two tabs, one showing the chat: only that tab navigates", async () => {
    const b = bus();
    const withChat = tab(["chat-1"], b.join());
    const elsewhere = tab([], b.join());
    const event = { type: "navigate_templates", fromSessionId: "chat-1", navId: "n1" };

    // The SSE reaches the other tab first — it must still not move.
    elsewhere.deliver(event);
    withChat.deliver(event);
    expect(withChat.go).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(TAB_NAV_CLAIM_WAIT_MS + 50);
    expect(elsewhere.go).not.toHaveBeenCalled();
    expect(withChat.go).toHaveBeenCalledOnce();
  });

  it("a chat no tab shows: the tabs navigate after the wait, as before", async () => {
    const b = bus();
    const a = tab([], b.join());
    const c = tab(["other-chat"], b.join());
    const event = { fromSessionId: "chat-1", navId: "n2" };
    a.deliver(event);
    c.deliver(event);
    expect(a.go).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(TAB_NAV_CLAIM_WAIT_MS + 50);
    expect(a.go).toHaveBeenCalledOnce();
    expect(c.go).toHaveBeenCalledOnce();
  });

  it("no originating chat (a CLI agent via libi connect): every tab navigates at once", () => {
    const b = bus();
    const a = tab([], b.join());
    const c = tab(["chat-1"], b.join());
    a.deliver({ type: "navigate_agents", tab: "libi-mcp" });
    c.deliver({ type: "navigate_agents", tab: "libi-mcp" });
    expect(a.go).toHaveBeenCalledOnce();
    expect(c.go).toHaveBeenCalledOnce();
  });

  it("a claim for one event does not silence another", async () => {
    const b = bus();
    const withChat = tab(["chat-1"], b.join());
    const elsewhere = tab([], b.join());
    withChat.deliver({ fromSessionId: "chat-1", navId: "n3" });
    elsewhere.deliver({ fromSessionId: "chat-1", navId: "n3" });
    elsewhere.deliver({ fromSessionId: "chat-2", navId: "n4" }); // a chat shown nowhere
    await vi.advanceTimersByTimeAsync(TAB_NAV_CLAIM_WAIT_MS + 50);
    expect(elsewhere.go).toHaveBeenCalledOnce(); // n4 only
  });

  it("without a BroadcastChannel a tab not showing the chat still navigates after the wait", async () => {
    const lonely = tab([], null);
    lonely.deliver({ fromSessionId: "chat-1", navId: "n5" });
    await vi.advanceTimersByTimeAsync(TAB_NAV_CLAIM_WAIT_MS + 50);
    expect(lonely.go).toHaveBeenCalledOnce();
  });
});
