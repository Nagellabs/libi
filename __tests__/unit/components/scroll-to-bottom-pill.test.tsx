// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ScrollToBottomPill from "@/components/chat/scroll-to-bottom-pill";
import type { ChatMessage } from "@/lib/chat/stream-state";

/**
 * The pill used to say "New messages" whenever the user was not at the bottom
 * and the transcript was not empty — no newness signal existed anywhere in the
 * codebase. Scrolling up through an idle, fully-read chat therefore announced
 * messages that did not exist.
 *
 * The control has two jobs and now says which one it is doing: "New messages"
 * only when content actually arrived after the user left the bottom, otherwise
 * a plain jump-to-latest affordance in the same place, with the same shape.
 * The label is binary — no counter — and the newness is computed by the panel,
 * so the pill itself stays presentational.
 *
 * The panel then went one step further: an honest label is still an unwanted
 * badge when there is nothing to jump TO. Scrolling back through a finished
 * conversation to re-read something now shows no pill at all; it appears only
 * while the agent is writing, or while output that arrived after the user left
 * the bottom is still unread.
 */

const messageListeners = new Set<() => void>();
let messagesSnapshot: ChatMessage[] = [];
/** `chat.isLoading` — the same streaming signal that drives the composer's
 *  Stop button, and now half of the pill's visibility gate. */
let streamingSnapshot = false;

/** ChatPanel is memo'd, so a plain rerender with identical props bails out.
 *  Messages are modelled as a real external store the panel subscribes to —
 *  the same way an SSE chunk actually re-renders it. */
function pushMessages(next: ChatMessage[]) {
  messagesSnapshot = next;
  act(() => {
    for (const listener of messageListeners) listener();
  });
}

/** Start/stop the agent. Routed through the same external store so the flip
 *  actually re-renders the memo'd panel, exactly as a real turn ending does. */
function setStreaming(next: boolean) {
  streamingSnapshot = next;
  act(() => {
    for (const listener of messageListeners) listener();
  });
}

const text = (id: string, role: "user" | "agent", body: string): ChatMessage => ({
  id,
  role,
  parts: [{ type: "text", text: body }],
  timestamp: 1_700_000_000_000,
});

/** A tool call mid-run: one part, no text anywhere, only `progress` moving.
 *  `stream-state` REPLACES the progress string on each ACP `tool_call_update`
 *  rather than appending to it, so the realistic shape is a counter where a
 *  single digit changes and the length does not move at all. */
const toolCall = (id: string, progress: string): ChatMessage => ({
  id,
  role: "agent",
  parts: [
    {
      type: "tool-call",
      toolCallId: `${id}-call`,
      toolId: null,
      rawTitle: "Bash",
      args: {},
      progress,
    },
  ],
  timestamp: 1_700_000_000_000,
});

vi.mock("@/lib/editor-state-context", () => ({
  useEditorState: () => ({
    activeProviderId: "codex",
    isAgentConnecting: false,
    selectAgent: vi.fn(),
    agentProviders: [],
    agentProvidersLoaded: true,
    refreshAgentProviders: vi.fn(),
    prefilledMessage: null,
    setPrefilledMessage: vi.fn(),
    onboardingDemoOffer: false,
    setOnboardingDemoOffer: vi.fn(),
    viewMode: "editor",
    sessionList: {
      readiness: { state: "ready" },
      readinessFor: () => ({ state: "ready" }),
    },
  }),
}));

vi.mock("@/hooks/sessions/use-agent-chat", () => ({
  useAgentChat: () => ({
    messages: React.useSyncExternalStore(
      (onChange: () => void) => {
        messageListeners.add(onChange);
        return () => messageListeners.delete(onChange);
      },
      () => messagesSnapshot,
      () => messagesSnapshot,
    ),
    sendMessage: vi.fn(),
    retryMessage: vi.fn(),
    isStreaming: false,
    cancelStream: vi.fn(),
    error: null,
    isLoading: React.useSyncExternalStore(
      (onChange: () => void) => {
        messageListeners.add(onChange);
        return () => messageListeners.delete(onChange);
      },
      () => streamingSnapshot,
      () => streamingSnapshot,
    ),
    sessionReady: true,
    cancelMessage: vi.fn(),
    status: "connected",
  }),
  subscribeBroadcast: () => () => {},
  sessionContextEmitter: { on: () => () => {}, emit: vi.fn() },
  sessionModelEmitter: { on: () => () => {}, emit: vi.fn() },
}));

vi.mock("@/lib/queries/files", () => ({
  useFiles: () => ({ data: [] }),
  useGlobalFiles: () => ({ data: [] }),
  useFileUpload: () => ({ upload: vi.fn() }),
}));
vi.mock("@/lib/queries/session-context", () => ({
  useSessionContext: () => ({ commands: [], usage: null }),
}));
vi.mock("@/lib/queries/session-model", () => ({
  useSessionModel: () => ({ data: null, isLoading: false }),
  useSetSessionModel: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/lib/queries/plan-usage", () => ({
  usePlanUsage: () => ({ data: null }),
}));
vi.mock("@/hooks/agents/use-run-remedy-in-terminal", () => ({
  useRunRemedyInTerminal: () => vi.fn(() => Promise.resolve()),
}));

/** jsdom does no layout: supply the metrics the scroll hook reads. */
function instrument(el: HTMLElement) {
  const metrics = { scrollHeight: 5000, clientHeight: 400, scrollTop: 0 };
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => metrics.scrollHeight,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => metrics.clientHeight,
  });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => metrics.scrollTop,
    set: (next: number) => {
      metrics.scrollTop = next;
    },
  });
  el.scrollTo = ((opts: ScrollToOptions | number) => {
    metrics.scrollTop = typeof opts === "number" ? opts : (opts?.top ?? 0);
  }) as HTMLElement["scrollTo"];
  return metrics;
}

async function mountPanel() {
  const { default: ChatPanel } = await import("@/components/chat/chat-panel");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <ChatPanel sessionId="A" />
    </QueryClientProvider>,
  );
  const el = view.container.querySelector<HTMLDivElement>(".overflow-y-auto");
  if (!el) throw new Error("chat scroll container not found");
  const metrics = instrument(el);

  return {
    metrics,
    userScrollTo(top: number) {
      metrics.scrollTop = top;
      fireEvent.scroll(el);
    },
    pillLabel() {
      return view.container.querySelector(".sticky.bottom-2 button")?.textContent?.trim() ?? null;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  messageListeners.clear();
  messagesSnapshot = [];
  // This suite has no global `clearMocks`, and `clearAllMocks` wipes call
  // records but not implementations — module-level state has to be restored by
  // hand or it leaks into the next test as a silently-passing assertion.
  streamingSnapshot = false;
});

describe("ScrollToBottomPill", () => {
  it("says New messages only when the panel says content arrived", () => {
    const { container } = render(
      <ScrollToBottomPill visible hasNewMessages onScrollToBottom={vi.fn()} />,
    );
    expect(container.querySelector("button")?.textContent?.trim()).toBe("New messages");
  });

  it("offers an honest jump-to-latest label when nothing arrived", () => {
    const { container } = render(
      <ScrollToBottomPill visible hasNewMessages={false} onScrollToBottom={vi.fn()} />,
    );
    const label = container.querySelector("button")?.textContent?.trim();
    expect(label).not.toBe("New messages");
    expect(label).toBe("Jump to latest");
  });

  it("renders nothing when not visible", () => {
    const { container } = render(
      <ScrollToBottomPill visible={false} hasNewMessages onScrollToBottom={vi.fn()} />,
    );
    expect(container.querySelector("button")).toBeNull();
  });

  it("is a pointer target, like every other interactive element in the app", () => {
    const { container } = render(
      <ScrollToBottomPill visible hasNewMessages={false} onScrollToBottom={vi.fn()} />,
    );
    expect(container.querySelector("button")).toHaveClass("cursor-pointer");
  });
});

describe("ChatPanel — when the pill is allowed to show at all", () => {
  it("stays out of the way when the user scrolls up through an idle chat", async () => {
    // The complaint, verbatim: re-reading a finished conversation should not
    // put a permanent badge over the composer. Nothing is generating and
    // everything below is already read, so there is nothing to jump to.
    const h = await mountPanel();
    pushMessages([text("a1", "user", "make a video"), text("a2", "agent", "done")]);

    h.userScrollTo(4000);

    expect(h.pillLabel()).toBeNull();
  });

  it("appears while the agent is writing, before the first chunk lands", async () => {
    // The turn is underway but has not grown the transcript yet — there is a
    // real reason to offer the jump, and nothing new to claim, so the pill
    // shows in its plain form.
    const h = await mountPanel();
    setStreaming(true);
    pushMessages([text("a1", "user", "make a video")]);

    h.userScrollTo(1000);

    expect(h.pillLabel()).toBe("Jump to latest");
  });

  it("claims new messages once content arrives while the user is scrolled up", async () => {
    const h = await mountPanel();
    setStreaming(true);
    pushMessages([text("a1", "user", "make a video"), text("a2", "agent", "done")]);

    h.userScrollTo(1000);
    expect(h.pillLabel()).toBe("Jump to latest");

    h.metrics.scrollHeight = 7000;
    pushMessages([
      text("a1", "user", "make a video"),
      text("a2", "agent", "done"),
      text("a3", "user", "now add music"),
    ]);

    expect(h.pillLabel()).toBe("New messages");
  });

  it("counts a stream growing the message already on screen as new content", async () => {
    // A turn that is already underway appends to the LAST message rather than
    // adding one, so message count alone would miss the case the pill exists
    // for most: the user scrolls up mid-answer and the answer keeps growing.
    const h = await mountPanel();
    setStreaming(true);
    pushMessages([text("a1", "user", "make a video"), text("a2", "agent", "work")]);

    h.userScrollTo(1000);
    expect(h.pillLabel()).toBe("Jump to latest");

    h.metrics.scrollHeight = 7000;
    pushMessages([
      text("a1", "user", "make a video"),
      text("a2", "agent", "working on it, here is a great deal more"),
    ]);

    expect(h.pillLabel()).toBe("New messages");
  });

  it("counts a tool call's progress advancing as new content", async () => {
    // The newness signal measured message count plus the last message's text,
    // so a tool call that is only reporting on itself registered as nothing at
    // all — and the pill offered "Jump to latest" while the agent was visibly
    // working. Progress is replaced, not appended, so the case that matters is
    // the one where the string does not even change LENGTH.
    const h = await mountPanel();
    setStreaming(true);
    pushMessages([text("a1", "user", "render it"), toolCall("a2", "Rendering frame 12/50")]);

    h.userScrollTo(1000);
    expect(h.pillLabel()).toBe("Jump to latest");

    pushMessages([text("a1", "user", "render it"), toolCall("a2", "Rendering frame 13/50")]);

    expect(h.pillLabel()).toBe("New messages");
  });

  it("does not invent new content when the same progress is re-delivered", async () => {
    // The counterweight to the test above: SSE re-fans a cached event on
    // reconnect, so an unchanged progress string arrives again on a fresh
    // message array. A signal that fired on identity rather than value would
    // turn every reconnect into a false "New messages".
    const h = await mountPanel();
    setStreaming(true);
    pushMessages([text("a1", "user", "render it"), toolCall("a2", "Rendering frame 12/50")]);

    h.userScrollTo(1000);
    expect(h.pillLabel()).toBe("Jump to latest");

    pushMessages([text("a1", "user", "render it"), toolCall("a2", "Rendering frame 12/50")]);

    expect(h.pillLabel()).toBe("Jump to latest");
  });

  it("survives the turn ending, so unread output is never left unreachable", async () => {
    // Gating on streaming alone would yank the pill away the moment the agent
    // stopped — leaving the user scrolled up with output they have not read and
    // no affordance to get down to it. Worse than the badge it removes.
    const h = await mountPanel();
    setStreaming(true);
    pushMessages([text("a1", "user", "make a video"), text("a2", "agent", "work")]);

    h.userScrollTo(1000);
    h.metrics.scrollHeight = 7000;
    pushMessages([
      text("a1", "user", "make a video"),
      text("a2", "agent", "work"),
      text("a3", "agent", "and here is the result"),
    ]);
    expect(h.pillLabel()).toBe("New messages");

    setStreaming(false);

    expect(h.pillLabel()).toBe("New messages");
  });

  it("goes quiet again once the user has been back to the bottom", async () => {
    const h = await mountPanel();
    setStreaming(true);
    pushMessages([text("a1", "user", "make a video"), text("a2", "agent", "done")]);

    h.userScrollTo(1000);
    h.metrics.scrollHeight = 7000;
    pushMessages([
      text("a1", "user", "make a video"),
      text("a2", "agent", "done"),
      text("a3", "user", "now add music"),
    ]);
    expect(h.pillLabel()).toBe("New messages");

    // Back to the bottom: the pill goes away and the newness is spent.
    h.userScrollTo(7000);
    expect(h.pillLabel()).toBeNull();

    // Agent idle, scrolling up again: nothing unread, nothing incoming, so
    // the pill must not come back — this is the loop that made it feel like a
    // permanent fixture.
    setStreaming(false);
    h.userScrollTo(1000);
    expect(h.pillLabel()).toBeNull();
  });
});
