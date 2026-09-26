// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * The chat's side of "Restart session", driven only by the ONE global SSE connection
 * (`session-restart` started / done / failed — no EventSource of its own). A restart cancels the
 * running turn, so the busy state (Stop button) must end; the load that follows REPLAYS the
 * history as ordinary stream events, which must not be appended to what the chat already shows —
 * on `done` the chat takes a fresh history instead.
 */

class MockEventSource {
  static instances = 0;
  static live: MockEventSource | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  close = vi.fn();
  constructor() {
    MockEventSource.instances++;
    MockEventSource.live = this;
  }
}
vi.stubGlobal("EventSource", MockEventSource);

const { useAgentChat } = await import("@/hooks/sessions/use-agent-chat");
const { restartSignals } = await import("@/hooks/sessions/restart-signals");

function emit(payload: Record<string, unknown>) {
  act(() => {
    MockEventSource.live?.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  });
}

const HISTORY = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "make a video" }], timestamp: 1 },
  { id: "a1", role: "agent", parts: [{ type: "text", text: "on it" }], timestamp: 2 },
];

let historyCalls = 0;
/** What GET /api/sessions/:id/restart answers: whether the server is still restarting that chat. */
let serverRestarting = new Set<string>();
let restartProbes = 0;
/** How the probe fails, when it does. */
let probeFails: "reject" | "500" | null = null;
/** When set, the probe's answer waits for this. */
let probeGate: Promise<void> | null = null;
beforeEach(() => {
  historyCalls = 0;
  restartProbes = 0;
  serverRestarting = new Set();
  probeFails = null;
  probeGate = null;
  vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/agent/messages")) {
      historyCalls++;
      return new Response(JSON.stringify({ messages: HISTORY }), { status: 200 });
    }
    const probe = /^\/api\/sessions\/([^/]+)\/restart$/.exec(url);
    if (probe && (init?.method ?? "GET") === "GET") {
      restartProbes++;
      // Computed when the request reaches the server, answered when the gate opens.
      const restarting = serverRestarting.has(decodeURIComponent(probe[1]));
      if (probeGate) await probeGate;
      if (probeFails === "reject") throw new TypeError("Failed to fetch");
      if (probeFails === "500") return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      return new Response(JSON.stringify({ restarting }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
});

/** The global SSE connection errors, comes back 3 s later, and opens. */
function dropAndReconnect() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    act(() => {
      MockEventSource.live?.onerror?.(new Event("error"));
      vi.advanceTimersByTime(3000);
    });
  } finally {
    vi.useRealTimers();
  }
  act(() => MockEventSource.live?.onopen?.(new Event("open")));
}

describe("useAgentChat — Restart session", () => {
  it("ends the busy state, skips the replay, and shows a fresh history once the chat is back", async () => {
    const sid = "restart-1";
    const { result } = renderHook(() => useAgentChat(sid));
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    const instancesBefore = MockEventSource.instances;

    emit({ type: "agent-status", status: "thinking", sessionId: sid });
    emit({ type: "agent-text", text: "working…", sessionId: sid });
    expect(result.current.isLoading).toBe(true);

    emit({ type: "session-restart", phase: "started", sessionId: sid });
    expect(result.current.status).toBe("connecting");
    expect(result.current.isLoading).toBe(false); // no Stop button for a turn being cancelled

    // The cancelled turn's terminal ends the streaming message, but the chat stays "connecting".
    emit({ type: "agent-complete", stopReason: "cancelled", sessionId: sid });
    expect(result.current.messages.some((m) => m.isStreaming)).toBe(false);
    expect(result.current.status).toBe("connecting");

    // The load's replay and statuses arrive meanwhile — none of it lands in the chat.
    emit({ type: "agent-status", status: "connecting", sessionId: sid });
    emit({ type: "agent-text", text: "on it", sessionId: sid });
    emit({ type: "agent-status", status: "error", error: "ACP connection closed", sessionId: sid });
    emit({ type: "agent-status", status: "connected", sessionId: sid });
    expect(result.current.status).toBe("connecting");
    expect(result.current.messages.map((m) => m.parts.map((p) => ("text" in p ? p.text : "")).join(""))).not.toContain("ACP connection closed");

    const before = historyCalls;
    emit({ type: "session-restart", phase: "done", sessionId: sid });
    await waitFor(() => expect(historyCalls).toBe(before + 1));
    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(result.current.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(result.current.isLoading).toBe(false);
    expect(MockEventSource.instances).toBe(instancesBefore); // the one global connection, no other

    // The chat is live again: a new turn streams as usual.
    emit({ type: "agent-status", status: "thinking", sessionId: sid });
    emit({ type: "agent-text", text: "next", sessionId: sid });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.messages.at(-1)?.parts).toEqual([{ type: "text", text: "next" }]);
  });

  it("a failed restart says why in the chat, keeps what was shown, and lets the user send again", async () => {
    const sid = "restart-2";
    const { result } = renderHook(() => useAgentChat(sid));
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    emit({ type: "session-restart", phase: "started", sessionId: sid });
    emit({ type: "session-restart", phase: "failed", error: "The chat couldn't be loaded again: thread not found", sessionId: sid });

    expect(result.current.status).toBe("connected");
    expect(result.current.sessionReady).toBe(true);
    const texts = result.current.messages.map((m) => m.parts.map((p) => ("text" in p ? p.text : "")).join(""));
    expect(texts.slice(0, 2)).toEqual(["make a video", "on it"]);
    expect(texts.at(-1)).toBe("Restart failed. The chat couldn't be loaded again: thread not found");
  });

  it("a failed history fetch after `done` keeps what the chat shows, and only settles (F8)", async () => {
    const sid = "restart-history-500";
    const { result } = renderHook(() => useAgentChat(sid));
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    emit({ type: "session-restart", phase: "started", sessionId: sid });
    let failedCalls = 0;
    vi.mocked(global.fetch).mockImplementation(async (input) => {
      if (String(input).startsWith("/api/agent/messages")) {
        failedCalls++;
        return new Response(JSON.stringify({ error: "Session restart-history-500 not found" }), { status: 500 });
      }
      return new Response("{}", { status: 200 });
    });
    emit({ type: "session-restart", phase: "done", sessionId: sid });

    await waitFor(() => expect(failedCalls).toBe(1));
    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(result.current.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("events for another chat's restart change nothing here", async () => {
    const { result } = renderHook(() => useAgentChat("restart-3"));
    await waitFor(() => expect(result.current.status).toBe("connected"));
    emit({ type: "session-restart", phase: "started", sessionId: "someone-else" });
    emit({ type: "agent-status", status: "thinking", sessionId: "restart-3" });
    expect(result.current.isLoading).toBe(true);
  });

  // Fix round 1: the wait must not depend on the SSE `done`/`failed` alone.
  describe("when the restart's SSE end never reaches this window", () => {
    it("this window's own request settling ends it, and a late SSE done is not a second swap", async () => {
      const sid = "restart-local-ok";
      const { result } = renderHook(() => useAgentChat(sid));
      await waitFor(() => expect(result.current.messages).toHaveLength(2));
      restartSignals.requested(sid);
      emit({ type: "session-restart", phase: "started", sessionId: sid });
      expect(result.current.status).toBe("connecting");

      const before = historyCalls;
      act(() => restartSignals.settled(sid, { ok: true }));
      await waitFor(() => expect(result.current.status).toBe("connected"));
      expect(historyCalls).toBe(before + 1);

      emit({ type: "session-restart", phase: "done", sessionId: sid });
      await new Promise((r) => setTimeout(r, 20));
      expect(historyCalls).toBe(before + 1);

      // Stream events are applied again.
      emit({ type: "agent-status", status: "thinking", sessionId: sid });
      emit({ type: "agent-text", text: "back", sessionId: sid });
      expect(result.current.isLoading).toBe(true);
      expect(result.current.messages.at(-1)?.parts).toEqual([{ type: "text", text: "back" }]);
    });

    it("a request that fails (the 90 s deadline) says why and hands the chat back", async () => {
      const sid = "restart-local-fail";
      const { result } = renderHook(() => useAgentChat(sid));
      await waitFor(() => expect(result.current.messages).toHaveLength(2));
      restartSignals.requested(sid);
      emit({ type: "session-restart", phase: "started", sessionId: sid });

      act(() => restartSignals.settled(sid, { ok: false, error: "The restart took longer than 90 seconds, so libi stopped waiting." }));

      expect(result.current.status).toBe("connected");
      const last = result.current.messages.at(-1);
      expect(last?.parts).toEqual([{ type: "text", text: "Restart failed. The restart took longer than 90 seconds, so libi stopped waiting." }]);
      emit({ type: "agent-status", status: "thinking", sessionId: sid });
      expect(result.current.isLoading).toBe(true);
    });

    it("the SSE coming back ends a restart another window asked for — but not one this window still waits on", async () => {
      const mine = "restart-mine";
      const theirs = "restart-theirs";
      const a = renderHook(() => useAgentChat(mine));
      const b = renderHook(() => useAgentChat(theirs));
      await waitFor(() => expect(a.result.current.messages).toHaveLength(2));
      await waitFor(() => expect(b.result.current.messages).toHaveLength(2));
      restartSignals.requested(mine);
      emit({ type: "session-restart", phase: "started", sessionId: mine });
      emit({ type: "session-restart", phase: "started", sessionId: theirs });
      const instances = MockEventSource.instances;

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        act(() => {
          MockEventSource.live?.onerror?.(new Event("error"));
          vi.advanceTimersByTime(3000);
        });
      } finally {
        vi.useRealTimers();
      }
      expect(MockEventSource.instances).toBe(instances + 1); // the one connection, re-opened
      act(() => MockEventSource.live?.onopen?.(new Event("open")));

      await waitFor(() => expect(b.result.current.status).toBe("connected"));
      expect(a.result.current.status).toBe("connecting");
      act(() => restartSignals.settled(mine, { ok: true }));
      await waitFor(() => expect(a.result.current.status).toBe("connected"));
    });
    it("an SSE end for ANOTHER window's restart leaves nothing behind to swallow this window's next outcome", async () => {
      const sid = "restart-stale-flag";
      const { result } = renderHook(() => useAgentChat(sid));
      await waitFor(() => expect(result.current.messages).toHaveLength(2));
      // Another window restarts this chat; this window only watches it over SSE.
      emit({ type: "session-restart", phase: "started", sessionId: sid });
      emit({ type: "session-restart", phase: "done", sessionId: sid });
      await waitFor(() => expect(result.current.status).toBe("connected"));

      // This window's own restart then fails before the server ever says `started` (not_found).
      restartSignals.requested(sid);
      act(() => restartSignals.settled(sid, { ok: false, error: "libi doesn't have this chat open any more." }));

      expect(result.current.messages.at(-1)?.parts).toEqual([{ type: "text", text: "Restart failed. libi doesn't have this chat open any more." }]);
    });
  });

  // Follow-up C3: the connection coming back must end only a restart that is really over.
  describe("the SSE coming back while ANOTHER window's restart is watched here (C3)", () => {
    it("keeps waiting while the server still restarts the chat, then swaps the history once, on its done", async () => {
      const sid = "restart-theirs-running";
      const { result } = renderHook(() => useAgentChat(sid));
      await waitFor(() => expect(result.current.messages).toHaveLength(2));
      emit({ type: "session-restart", phase: "started", sessionId: sid });
      serverRestarting.add(sid);
      const before = historyCalls;

      dropAndReconnect();
      await waitFor(() => expect(restartProbes).toBe(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(result.current.status).toBe("connecting");
      expect(historyCalls).toBe(before);

      // Its replay reaching this window meanwhile still lands nowhere.
      emit({ type: "agent-text", text: "on it", sessionId: sid });
      serverRestarting.delete(sid);
      emit({ type: "session-restart", phase: "done", sessionId: sid });
      await waitFor(() => expect(result.current.status).toBe("connected"));
      await new Promise((r) => setTimeout(r, 20));
      expect(historyCalls).toBe(before + 1);
      expect(result.current.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    });

    it("ends one that is over (its done was lost) once — a done arriving after that is not a second swap", async () => {
      const sid = "restart-theirs-over";
      const { result } = renderHook(() => useAgentChat(sid));
      await waitFor(() => expect(result.current.messages).toHaveLength(2));
      emit({ type: "session-restart", phase: "started", sessionId: sid });
      const before = historyCalls;

      dropAndReconnect();
      await waitFor(() => expect(result.current.status).toBe("connected"));
      expect(historyCalls).toBe(before + 1);

      emit({ type: "session-restart", phase: "done", sessionId: sid });
      await new Promise((r) => setTimeout(r, 20));
      expect(historyCalls).toBe(before + 1);

      // …and the next restart's end is not swallowed by that.
      emit({ type: "session-restart", phase: "started", sessionId: sid });
      emit({ type: "session-restart", phase: "done", sessionId: sid });
      await waitFor(() => expect(historyCalls).toBe(before + 2));
    });

    it("a reconnect with no restart under way asks the server nothing", async () => {
      const sid = "restart-none";
      const { result } = renderHook(() => useAgentChat(sid));
      await waitFor(() => expect(result.current.messages).toHaveLength(2));
      dropAndReconnect();
      await new Promise((r) => setTimeout(r, 20));
      expect(restartProbes).toBe(0);
    });

    it.each([["rejects", "reject"], ["answers 500", "500"]] as const)(
      "a probe that %s ends the wait (as before the probe existed)",
      async (_label, how) => {
        const sid = `restart-probe-${how}`;
        const { result } = renderHook(() => useAgentChat(sid));
        await waitFor(() => expect(result.current.messages).toHaveLength(2));
        emit({ type: "session-restart", phase: "started", sessionId: sid });
        probeFails = how;
        const before = historyCalls;

        dropAndReconnect();
        await waitFor(() => expect(result.current.status).toBe("connected"));
        expect(restartProbes).toBe(1);
        expect(historyCalls).toBe(before + 1);
      },
    );

    it("a probe answered for a restart that has since ended cannot end the NEXT one", async () => {
      const sid = "restart-probe-race";
      const { result } = renderHook(() => useAgentChat(sid));
      await waitFor(() => expect(result.current.messages).toHaveLength(2));
      emit({ type: "session-restart", phase: "started", sessionId: sid });
      let open!: () => void;
      probeGate = new Promise((r) => { open = r; });

      dropAndReconnect(); // the server says "not restarting" — the first restart is over…
      await waitFor(() => expect(restartProbes).toBe(1));
      emit({ type: "session-restart", phase: "done", sessionId: sid }); // …its done arrives…
      await waitFor(() => expect(result.current.status).toBe("connected"));
      emit({ type: "session-restart", phase: "started", sessionId: sid }); // …and a new one starts.
      const before = historyCalls;

      await act(async () => { open(); await new Promise((r) => setTimeout(r, 20)); });
      expect(result.current.status).toBe("connecting");
      expect(historyCalls).toBe(before);

      emit({ type: "session-restart", phase: "done", sessionId: sid });
      await waitFor(() => expect(historyCalls).toBe(before + 1));
      await waitFor(() => expect(result.current.status).toBe("connected"));
    });

    it("the mark a reconnect leaves expires, so a later end whose started was also missed still swaps", async () => {
      const { RECONNECT_DONE_GRACE_MS } = await import("@/hooks/sessions/use-agent-chat");
      const sid = "restart-mark-expires";
      const { result } = renderHook(() => useAgentChat(sid));
      await waitFor(() => expect(result.current.messages).toHaveLength(2));
      emit({ type: "session-restart", phase: "started", sessionId: sid });

      dropAndReconnect();
      await waitFor(() => expect(result.current.status).toBe("connected"));
      // Real timers: the mark's timer was armed after the probe answered.
      await act(async () => { await new Promise((r) => setTimeout(r, RECONNECT_DONE_GRACE_MS + 50)); });

      const before = historyCalls;
      emit({ type: "session-restart", phase: "done", sessionId: sid });
      await waitFor(() => expect(historyCalls).toBe(before + 1));
    }, 10_000);
  });
});
