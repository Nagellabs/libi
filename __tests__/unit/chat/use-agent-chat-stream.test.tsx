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
import { render, renderHook, act, cleanup } from "@testing-library/react";
import {
  useAgentChat,
  usePendingApprovalCount,
  useSessionGenerating,
  useSessionUnviewed,
  setViewedSession,
} from "@/hooks/sessions/use-agent-chat";
import { useSessionList } from "@/hooks/sessions/use-session-list";
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

describe("useAgentChat background completion", () => {
  /** Emit for an arbitrary session, not just the file-level SESSION. */
  function emitFor(sessionId: string, event: Record<string, unknown>) {
    lastES().onmessage?.({ data: JSON.stringify({ sessionId, ...event }) });
  }

  /** Reproduces the observed repro: send a prompt in session B, switch to
   *  session A while it runs, let B's turn finish while backgrounded, then
   *  switch back to B. B has no mounted handler at the moment its terminal
   *  event arrives, so only the SSE singleton can record it. */
  async function runBackgroundTurn(
    bg: string,
    fg: string,
    terminal: Record<string, unknown>,
  ) {
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useAgentChat(id),
      { initialProps: { id: bg } },
    );
    await act(async () => {});

    // The turn is in flight in `bg`.
    act(() => emitFor(bg, { type: "agent-status", status: "thinking" }));
    expect(result.current.isLoading).toBe(true);

    // Switch away. `bg` now has no mounted handler; `fg` keeps the single
    // global EventSource alive, exactly as the sidebar switch does.
    rerender({ id: fg });
    await act(async () => {});

    // `bg`'s turn ends while nobody is listening for it.
    act(() => emitFor(bg, terminal));

    // Switch back.
    rerender({ id: bg });
    await act(async () => {});
    return result;
  }

  it("a turn that completes while backgrounded does not leave a stuck Stop button", async () => {
    const result = await runBackgroundTurn("bg-complete", "fg-complete", {
      type: "agent-complete",
      stopReason: "end_turn",
    });

    expect(result.current.status).toBe("connected");
    expect(result.current.isLoading).toBe(false);
  });

  it("a turn cancelled while backgrounded settles the same way", async () => {
    // Cancellation reaches the client as the same `agent-complete` frame,
    // only with `stopReason: "cancelled"` — there is no separate event.
    const result = await runBackgroundTurn("bg-cancel", "fg-cancel", {
      type: "agent-complete",
      stopReason: "cancelled",
    });

    expect(result.current.isLoading).toBe(false);
  });

  it("a turn that errors while backgrounded settles too (via agent-status)", async () => {
    // Unlike completion, the failure terminal IS an `agent-status` frame, so
    // the pre-existing status caching already covered it. Pinned so a future
    // change to the error path can't quietly reintroduce the stuck state.
    const result = await runBackgroundTurn("bg-error", "fg-error", {
      type: "agent-status",
      status: "error",
      error: "boom",
    });

    expect(result.current.status).toBe("error");
    expect(result.current.isLoading).toBe(false);
  });
});

describe("useSessionGenerating (the sidebar's working indicator)", () => {
  /** The sidebar renders rows for sessions whose chat hook is NOT mounted, so
   *  every assertion here deliberately drives events at a session that has no
   *  `useAgentChat` anywhere — the singleton's status cache is the only thing
   *  that can answer for it. */
  function emitFor(sessionId: string, event: Record<string, unknown>) {
    lastES().onmessage?.({ data: JSON.stringify({ sessionId, ...event }) });
  }

  it("reports a backgrounded session as working, and stops when its turn ends", async () => {
    const { result } = renderHook(() => useSessionGenerating("dot-bg"));
    await act(async () => {});
    expect(result.current).toBe(false);

    act(() => emitFor("dot-bg", { type: "agent-status", status: "thinking" }));
    expect(result.current).toBe(true);

    // Success emits `agent-complete` and no closing `agent-status`. If the
    // singleton did not cache that terminal, this dot would spin forever on a
    // session the user has switched away from — the exact stuck state fixed in
    // `Clear the Stop button when a turn finishes in a backgrounded session`.
    act(() => emitFor("dot-bg", { type: "agent-complete", stopReason: "end_turn" }));
    expect(result.current).toBe(false);
  });

  it("subscribes to ONE session, not to any session that happens to be busy", async () => {
    const { result } = renderHook(() => useSessionGenerating("dot-quiet"));
    await act(async () => {});

    act(() => emitFor("dot-noisy", { type: "agent-status", status: "thinking" }));
    expect(result.current).toBe(false);
  });

  it("holds the one global EventSource open on its own", async () => {
    // The sidebar can be the ONLY subscriber — no chat hook is mounted on
    // /settings. If this hook did not count as a handler, an unrelated
    // unsubscribe would close the stream and the dots would silently stop
    // updating instead of visibly breaking.
    const before = FakeEventSource.instances.length;
    const dot = renderHook(() => useSessionGenerating("dot-stream"));
    const approvals = renderHook(() => usePendingApprovalCount("dot-stream"));
    await act(async () => {});
    expect(FakeEventSource.instances.length).toBeGreaterThan(before);

    approvals.unmount();
    expect(lastES().closed).toBe(false);
    // …and it still delivers.
    act(() => emitFor("dot-stream", { type: "agent-status", status: "thinking" }));
    expect(dot.result.current).toBe(true);

    dot.unmount();
    // Last subscriber gone — the singleton closes rather than leaking.
    expect(
      FakeEventSource.instances[FakeEventSource.instances.length - 1].closed,
    ).toBe(true);
  });

  it("stays false for a session that only ever streamed text (no status frame)", async () => {
    // Guards the predicate itself: "generating" is the same thing the composer
    // calls `isLoading`, and nothing else may light the dot.
    const { result } = renderHook(() => useSessionGenerating("dot-text"));
    await act(async () => {});
    act(() => emitFor("dot-text", { type: "agent-text", text: "hi" }));
    expect(result.current).toBe(false);
  });
});

describe("useSessionUnviewed (finished while you were elsewhere)", () => {
  /** Same rationale as the working-indicator suite: every session driven here
   *  deliberately has NO mounted `useAgentChat`, because "a turn finished in a
   *  session you are not looking at" is by definition a session with no
   *  composer on screen. The SSE singleton is the only listener that can see
   *  it. `agentId` rides along on the frames purely to prove it is ignored. */
  function emitFor(sessionId: string, event: Record<string, unknown>) {
    lastES().onmessage?.({ data: JSON.stringify({ sessionId, ...event }) });
  }

  /** Records EVERY value the hook ever rendered, not just the final one —
   *  which is what lets the no-flash invariant be asserted rather than
   *  assumed. */
  function probe(sessionId: string) {
    const seen: boolean[] = [];
    function Probe() {
      seen.push(useSessionUnviewed(sessionId));
      return null;
    }
    render(<Probe />);
    return seen;
  }

  beforeEach(() => {
    // Module-level state outlives a test. Nothing is being viewed at the start
    // of each one; ids are kept distinct per test so the unviewed set can't
    // leak either.
    setViewedSession(null);
  });

  it("marks a session whose turn completed while it was NOT the one on screen", async () => {
    setViewedSession("uv-elsewhere");
    const { result } = renderHook(() => useSessionUnviewed("uv-bg"));
    await act(async () => {});
    expect(result.current).toBe(false);

    act(() => emitFor("uv-bg", { type: "agent-status", status: "thinking" }));
    expect(result.current).toBe(false); // still working, not yet a result

    act(() => emitFor("uv-bg", { type: "agent-complete", stopReason: "end_turn" }));
    expect(result.current).toBe(true);
  });

  it("never marks the session that is on screen — not even for one render", async () => {
    // The invariant that matters most: a "you haven't seen this" mark flashing
    // on the session the user is staring at is worse than no feature at all.
    // It must hold BY CONSTRUCTION (the completion is never recorded), not by
    // a clear that races the paint — so this asserts on every rendered value,
    // not on the settled one.
    setViewedSession("uv-onscreen");
    const seen = probe("uv-onscreen");

    act(() => emitFor("uv-onscreen", { type: "agent-status", status: "thinking" }));
    act(() => emitFor("uv-onscreen", { type: "agent-complete", stopReason: "end_turn" }));
    await act(async () => {});

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v === false)).toBe(true);
  });

  it("clears the moment the user opens the session", async () => {
    const { result } = renderHook(() => useSessionUnviewed("uv-open"));
    await act(async () => {});
    act(() => emitFor("uv-open", { type: "agent-complete", stopReason: "end_turn" }));
    expect(result.current).toBe(true);

    act(() => setViewedSession("uv-open"));
    expect(result.current).toBe(false);
  });

  it("is cleared by VIEWING, not by any other navigation", async () => {
    // Switching to a third session, or to /settings and back, must not eat the
    // marker — otherwise the one signal that a background turn ever produced
    // is lost silently, which is the failure this whole feature exists to fix.
    const { result } = renderHook(() => useSessionUnviewed("uv-keep"));
    await act(async () => {});
    act(() => emitFor("uv-keep", { type: "agent-complete", stopReason: "end_turn" }));
    expect(result.current).toBe(true);

    act(() => setViewedSession("uv-third"));
    act(() => setViewedSession("uv-fourth"));
    expect(result.current).toBe(true);
  });

  it("gives way when the same session starts a new turn", async () => {
    // The states are exclusive: a session that is working again no longer has
    // a finished-but-unseen result, it has a turn in flight.
    const unviewed = renderHook(() => useSessionUnviewed("uv-again"));
    const working = renderHook(() => useSessionGenerating("uv-again"));
    await act(async () => {});
    act(() => emitFor("uv-again", { type: "agent-complete", stopReason: "end_turn" }));
    expect(unviewed.result.current).toBe(true);

    act(() => emitFor("uv-again", { type: "agent-status", status: "thinking" }));
    expect(unviewed.result.current).toBe(false);
    expect(working.result.current).toBe(true);
  });

  it("ignores a turn the user cancelled themselves", async () => {
    // Cancellation arrives as the same `agent-complete` frame with
    // `stopReason: "cancelled"`. The user stopped that turn on purpose;
    // telling them a result is waiting would be noise.
    const { result } = renderHook(() => useSessionUnviewed("uv-cancel"));
    await act(async () => {});
    act(() => emitFor("uv-cancel", { type: "agent-complete", stopReason: "cancelled" }));
    expect(result.current).toBe(false);
  });

  it("behaves identically for an agent that does not exist yet", async () => {
    // The requirement is agent-agnostic BY CONSTRUCTION: nothing here reads
    // `agentId`, so a third coding agent added tomorrow works with zero
    // changes. Drive the same machine twice — once tagged as today's agent,
    // once as an invented one — and demand the same answer.
    const results: boolean[] = [];
    for (const agentId of ["claude-code", "an-agent-invented-in-2027"]) {
      const sessionId = `uv-agnostic-${agentId}`;
      const { result } = renderHook(() => useSessionUnviewed(sessionId));
      await act(async () => {});
      act(() => emitFor(sessionId, { type: "agent-status", status: "thinking", agentId }));
      act(() =>
        emitFor(sessionId, { type: "agent-complete", stopReason: "end_turn", agentId }),
      );
      results.push(result.current);
    }
    expect(results).toEqual([true, true]);
  });

  it("holds the one global EventSource open on its own", async () => {
    // Same gap the working indicator had: the sidebar can be the ONLY
    // subscriber (no chat hook is mounted on /settings). If this hook did not
    // count as a handler, an unrelated unsubscribe would close the stream and
    // the marks would go quietly stale instead of visibly breaking.
    const before = FakeEventSource.instances.length;
    const unviewed = renderHook(() => useSessionUnviewed("uv-stream"));
    const approvals = renderHook(() => usePendingApprovalCount("uv-stream"));
    await act(async () => {});
    expect(FakeEventSource.instances.length).toBeGreaterThan(before);

    approvals.unmount();
    expect(lastES().closed).toBe(false);
    act(() => emitFor("uv-stream", { type: "agent-complete", stopReason: "end_turn" }));
    expect(unviewed.result.current).toBe(true);

    unviewed.unmount();
    expect(
      FakeEventSource.instances[FakeEventSource.instances.length - 1].closed,
    ).toBe(true);
  });

  it("is wired to the real session switch, not only to the setter", async () => {
    // The state is worthless if nothing tells it what the user is looking at.
    // `useSessionList` owns that answer for the whole app, so drive the actual
    // hook rather than trusting the funnel to stay connected.
    const { result } = renderHook(() => useSessionUnviewed("uv-wired"));
    const list = renderHook(() => useSessionList());
    await act(async () => {});

    act(() => emitFor("uv-wired", { type: "agent-complete", stopReason: "end_turn" }));
    expect(result.current).toBe(true);

    act(() => list.result.current.switchSession("uv-wired"));
    expect(result.current).toBe(false);
  });
});
