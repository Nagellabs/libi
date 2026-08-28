// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChatMessage } from "@/lib/chat/stream-state";

/**
 * The scroll restore that fired against the wrong session.
 *
 * `useAgentChat` clears its messages in an EFFECT, so switching A→B produces
 * three commits in order: (1) session prop is B, A's transcript still
 * rendered; (2) messages `[]`; (3) B's own messages. The panel's one-shot
 * restore used to run on commit (1) — A's DOM, B's saved offset, one shot
 * spent — and by commit (3) there was nothing left to restore with.
 *
 * These tests drive that exact three-commit sequence through the REAL
 * `useScrollToBottom` (only `useAgentChat` is faked), because the bug lives in
 * the seam between the two.
 */

const messageListeners = new Set<() => void>();
let messagesSnapshot: ChatMessage[] = [];

/** ChatPanel is memo'd, so a plain rerender with identical props bails out.
 *  Messages are modelled as a real external store the panel subscribes to —
 *  the same way an SSE chunk or a history fetch actually re-renders it. */
function pushMessages(next: ChatMessage[]) {
  messagesSnapshot = next;
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
    isLoading: false,
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

const key = (sessionId: string) => `libi:chat-scroll:${sessionId}`;

/** The remembered OFFSET, out of whichever shape the key is holding: a bare
 *  number from a release that stored nothing else, or the record that also
 *  carries the transcript size the offset was taken in. */
function savedTop(sessionId: string): number | null {
  const raw = localStorage.getItem(key(sessionId));
  if (raw === null) return null;
  return raw.startsWith("{") ? (JSON.parse(raw).top as number) : Number(raw);
}

/** jsdom does no layout: the panel's scroll container reports 0 for every
 *  metric and has no working `scrollTo`. Supply them, mutable, so a commit can
 *  change the transcript's height the way real content would. */
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

async function mount(sessionId: string) {
  const { default: ChatPanel } = await import("@/components/chat/chat-panel");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <ChatPanel sessionId={sessionId} pieceId="piece-1" />
    </QueryClientProvider>,
  );
  const el = view.container.querySelector<HTMLDivElement>(".overflow-y-auto");
  if (!el) throw new Error("chat scroll container not found");
  const metrics = instrument(el);

  return {
    metrics,
    el,
    switchTo(nextSessionId: string) {
      act(() => {
        view.rerender(
          <QueryClientProvider client={qc}>
            <ChatPanel sessionId={nextSessionId} pieceId="piece-1" />
          </QueryClientProvider>,
        );
      });
    },
    /** A real user scroll: the browser moves scrollTop, then fires the event. */
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
});

describe("ChatPanel — scroll restore across a session switch", () => {
  it("restores against the NEW session's messages, not the outgoing session's DOM", async () => {
    localStorage.setItem(key("B"), "1500");
    const h = await mount("A");

    // A is loaded and the user is at the bottom of a tall transcript.
    pushMessages([text("a1", "user", "make a video"), text("a2", "agent", "on it")]);

    // Commit 1: the session prop flips to B while A's messages are still
    // rendered. Nothing may move here.
    h.switchTo("B");
    expect(h.metrics.scrollTop).toBe(5000);

    // Commit 2: useAgentChat's reset effect empties the list, and the
    // browser clamps scrollTop as the content disappears.
    pushMessages([]);
    h.metrics.scrollHeight = 0;
    h.userScrollTo(0);

    // Commit 3: B's real history lands.
    h.metrics.scrollHeight = 4000;
    pushMessages([text("b1", "user", "different piece"), text("b2", "agent", "sure")]);

    expect(h.metrics.scrollTop).toBe(1500);
  });

  it("ignores a scroll event that lands while the outgoing session is still rendered", async () => {
    // Stabilizing the hook's callback identity stops the restore effect from
    // re-running on the stale commit for the OBVIOUS reason. `isAtBottom` is
    // also in that effect's deps, though, and trackpad momentum keeps firing
    // scroll events straight through a session switch — so a flip there would
    // still restore A's DOM to B's offset and burn the one shot.
    localStorage.setItem(key("B"), "1500");
    const h = await mount("A");
    pushMessages([text("a1", "user", "make a video"), text("a2", "agent", "on it")]);

    // User is reading back through A, then switches away.
    h.userScrollTo(1000);
    h.switchTo("B");

    // Momentum carries them to the bottom of A's still-mounted transcript.
    h.userScrollTo(4900);
    expect(h.metrics.scrollTop).toBe(4900);

    // The clear, then B's own history.
    pushMessages([]);
    h.metrics.scrollHeight = 0;
    h.metrics.scrollHeight = 4000;
    pushMessages([text("b1", "user", "different piece"), text("b2", "agent", "sure")]);

    expect(h.metrics.scrollTop).toBe(1500);
  });

  it("does not write the empty interim's clamped offset into the new session's key", async () => {
    vi.useFakeTimers();
    localStorage.setItem(key("B"), "1500");
    const h = await mount("A");
    pushMessages([text("a1", "user", "hello")]);

    h.switchTo("B");
    pushMessages([]);
    h.metrics.scrollHeight = 0;
    h.userScrollTo(0);
    act(() => vi.advanceTimersByTime(400));

    expect(localStorage.getItem(key("B"))).toBe("1500");
    vi.useRealTimers();
  });

  it("switching INTO a streaming session restores once, against that session's own first batch", async () => {
    // SSE can populate the live tail before the history fetch resolves, so
    // the first non-empty batch may be a PARTIAL tail whose height then jumps
    // when the full snapshot lands. The restore is a one-shot: it belongs to
    // the first batch, and the taller snapshot must not re-trigger it (nor
    // yank a user who is deliberately reading further up).
    localStorage.setItem(key("B"), "600");
    const h = await mount("A");
    pushMessages([text("a1", "user", "hello")]);

    h.switchTo("B");
    pushMessages([]);
    h.metrics.scrollHeight = 0;

    // Partial live tail arrives first.
    h.metrics.scrollHeight = 1200;
    pushMessages([text("b2", "agent", "…half a sentence")]);
    expect(h.metrics.scrollTop).toBe(600);

    // Full history snapshot supersedes it — much taller.
    h.metrics.scrollHeight = 9000;
    pushMessages([
      text("b1", "user", "long conversation"),
      text("b2", "agent", "…half a sentence and then some"),
    ]);

    // Still at the restored offset: no second restore, no auto-follow (the
    // restore left `isAtBottom` false because 600 is nowhere near the fold).
    expect(h.metrics.scrollTop).toBe(600);
  });

  it("switching to an EMPTY session leaves nothing saved and no stranded pill", async () => {
    vi.useFakeTimers();
    const h = await mount("A");
    pushMessages([text("a1", "user", "hello"), text("a2", "agent", "hi")]);
    // The user was reading back through A. Being scrolled up is not on its own
    // enough to show the pill any more, so give it the reason it needs: output
    // landing below them after they left the bottom.
    h.userScrollTo(200);
    h.metrics.scrollHeight = 7000;
    pushMessages([
      text("a1", "user", "hello"),
      text("a2", "agent", "hi"),
      text("a3", "agent", "and one more thing"),
    ]);
    expect(h.pillLabel()).not.toBeNull();

    h.switchTo("B");
    pushMessages([]);
    h.metrics.scrollHeight = 0;
    h.userScrollTo(0);
    act(() => vi.advanceTimersByTime(400));

    expect(localStorage.getItem(key("B"))).toBeNull();
    // An empty transcript has nothing to jump to — the pill must be gone.
    expect(h.pillLabel()).toBeNull();
    vi.useRealTimers();
  });

  it("A→B→A does not carry B's interim offset into A", async () => {
    vi.useFakeTimers();
    localStorage.setItem(key("A"), "2200");
    const h = await mount("A");
    pushMessages([text("a1", "user", "hello")]);

    h.switchTo("B");
    pushMessages([]);
    h.metrics.scrollHeight = 0;
    h.userScrollTo(0);

    h.switchTo("A");
    pushMessages([]);
    h.userScrollTo(0);
    act(() => vi.advanceTimersByTime(400));

    expect(savedTop("A")).toBe(2200);
    vi.useRealTimers();
  });
});

describe("ChatPanel — the path the pill exists for", () => {
  it("does not yank a scrolled-up user down while the agent streams", async () => {
    const h = await mount("A");
    pushMessages([text("a1", "user", "hello"), text("a2", "agent", "hi")]);
    expect(h.metrics.scrollTop).toBe(5000);

    // User scrolls up to re-read something.
    h.userScrollTo(1000);
    expect(h.metrics.scrollTop).toBe(1000);

    // The agent keeps streaming into the transcript.
    h.metrics.scrollHeight = 7000;
    pushMessages([
      text("a1", "user", "hello"),
      text("a2", "agent", "hi there, and here is a great deal more"),
    ]);

    expect(h.metrics.scrollTop).toBe(1000);
    expect(h.pillLabel()).toBe("New messages");
  });

  it("follows the stream while the user is at the bottom", async () => {
    const h = await mount("A");
    pushMessages([text("a1", "user", "hello"), text("a2", "agent", "hi")]);

    h.metrics.scrollHeight = 7000;
    pushMessages([
      text("a1", "user", "hello"),
      text("a2", "agent", "hi there, and here is a great deal more"),
    ]);

    expect(h.metrics.scrollTop).toBe(7000);
    expect(h.pillLabel()).toBeNull();
  });
});

/**
 * What the user asked for: come back to where you were, unless the agent has
 * been working — then come back to what it wrote.
 *
 * The signal is the TRANSCRIPT's size, saved next to the offset and compared
 * on return. Not "a turn completed while you were away" (`useAgentChat`'s
 * unviewed flag), which is blind to the commonest case of all: a session still
 * mid-answer, which is precisely a session the agent has been working in.
 */
describe("ChatPanel — returning to a session the agent worked in", () => {
  const aStart = () => [text("a1", "user", "make a video"), text("a2", "agent", "on it")];

  /** Visit A, leave the user part-way up it, and let the position save. */
  async function leaveAScrolledUp() {
    const h = await mount("A");
    pushMessages(aStart());
    h.userScrollTo(1200);
    act(() => vi.advanceTimersByTime(400));
    expect(savedTop("A")).toBe(1200);
    return h;
  }

  /** The three commits a switch actually renders, in order. */
  function switchAndLoad(h: Awaited<ReturnType<typeof mount>>, sessionId: string, messages: ChatMessage[]) {
    h.switchTo(sessionId);
    pushMessages([]);
    h.metrics.scrollHeight = 0;
    h.metrics.scrollHeight = 5000;
    pushMessages(messages);
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("lands on the newest message when the agent wrote while the user was away", async () => {
    const h = await leaveAScrolledUp();

    switchAndLoad(h, "B", [text("b1", "user", "different piece")]);

    // Back to A, which has grown a turn in the meantime.
    switchAndLoad(h, "A", [...aStart(), text("a3", "agent", "and here is the result")]);

    expect(h.metrics.scrollTop).toBe(5000);
    // Nothing to jump to: they are already looking at the newest message.
    expect(h.pillLabel()).toBeNull();
  });

  it("lands on the newest message when the turn they left is still being written", async () => {
    // Mid-generation: no new message, the last one is just longer. This is the
    // case a completed-turn signal cannot see at all.
    const h = await leaveAScrolledUp();

    switchAndLoad(h, "B", [text("b1", "user", "different piece")]);
    switchAndLoad(h, "A", [
      text("a1", "user", "make a video"),
      text("a2", "agent", "on it — and here is a great deal more of the answer"),
    ]);

    expect(h.metrics.scrollTop).toBe(5000);
  });

  it("puts the user back where they were when nothing arrived while they were away", async () => {
    const h = await leaveAScrolledUp();

    switchAndLoad(h, "B", [text("b1", "user", "different piece")]);
    switchAndLoad(h, "A", aStart());

    expect(h.metrics.scrollTop).toBe(1200);
  });

  it("does not yank a user who scrolled up while watching the agent work", async () => {
    // Growth they sat through is not growth they missed: the remembered size
    // keeps pace with the session on screen, so a flick to B and back leaves
    // them exactly where they had chosen to read.
    const h = await leaveAScrolledUp();

    // The agent streams on while A is still the session on screen.
    h.metrics.scrollHeight = 7000;
    pushMessages([...aStart(), text("a3", "agent", "still going")]);
    expect(h.metrics.scrollTop).toBe(1200);
    act(() => vi.advanceTimersByTime(400));

    switchAndLoad(h, "B", [text("b1", "user", "different piece")]);
    switchAndLoad(h, "A", [...aStart(), text("a3", "agent", "still going")]);

    expect(h.metrics.scrollTop).toBe(1200);
  });

  it("restores an offset saved before transcript sizes were stored", async () => {
    // The upgrade path. A bare number has no transcript to compare against, so
    // it restores exactly as it did before — the user keeps their position
    // rather than losing it to a format they have never written.
    localStorage.setItem(key("A"), "900");
    const h = await mount("B");
    pushMessages([text("b1", "user", "different piece")]);

    switchAndLoad(h, "A", aStart());

    expect(h.metrics.scrollTop).toBe(900);
  });
});
