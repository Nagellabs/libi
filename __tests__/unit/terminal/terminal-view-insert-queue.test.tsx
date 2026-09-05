// @vitest-environment jsdom
/**
 * Pins the insert-text queueing fix in components/terminal/terminal-view.tsx:
 * a paste dispatched on TERMINAL_INSERT_TEXT_EVENT while the socket is
 * reconnecting (or OPEN but pre-snapshot) must be held and delivered only
 * once this connection's `snapshot` message has actually been applied — never
 * on `onopen`, which fires before the `term.reset()` that would wipe it.
 *
 * xterm.js touches DOM/WebGL at module scope and every other terminal test in
 * this repo stubs it out rather than mounting it (see
 * terminal-panel-drop.test.tsx) — real xterm under jsdom is slow and
 * irrelevant to this bug, which lives entirely in terminal-view.tsx's own
 * wiring. So @xterm/xterm, the fit/web-links addons, WebSocket, fetch and
 * ResizeObserver are all faked here; the component itself (its effects, refs
 * and the queueing logic under test) is the real one, fully mounted.
 *
 * What this test does NOT prove: that a real xterm buffer visually shows the
 * pasted text, that the actual PTY/websocket wire protocol round-trips it, or
 * anything about the reconnect backoff schedule itself (untouched by this
 * change and not exercised here — connect() is driven directly).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

import { TERMINAL_INSERT_TEXT_EVENT } from "@/lib/onboarding/demo";

// ---- Fake xterm ------------------------------------------------------

interface OnDataHandler {
  (data: string): void;
}

class FakeTerminal {
  cols = 80;
  rows = 24;
  options: { theme?: unknown } = {};
  resetCalls = 0;
  writes: string[] = [];
  pastes: string[] = [];
  private dataHandler: OnDataHandler | null = null;

  open(): void {}
  loadAddon(): void {}
  focus(): void {}
  refresh(): void {}
  resize(): void {}
  dispose(): void {}
  onScroll(): { dispose(): void } {
    return { dispose() {} };
  }
  onData(cb: OnDataHandler): { dispose(): void } {
    this.dataHandler = cb;
    return { dispose() {} };
  }
  reset(): void {
    this.resetCalls++;
  }
  write(data: string, cb?: () => void): void {
    this.writes.push(data);
    cb?.();
  }
  // Real xterm's paste() feeds the pasted text through the same onData path
  // as user typing — that's how it reaches the WebSocket. Mirror that here.
  paste(text: string): void {
    this.pastes.push(text);
    this.dataHandler?.(text);
  }
}

let lastTerminal: FakeTerminal | null = null;

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor() {
      const t = new FakeTerminal();
      lastTerminal = t;
      return t as unknown as FakeTerminal;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {},
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

// ---- Fake WebSocket ---------------------------------------------------

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
  // --- test helpers ---
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  snapshot(data = ""): void {
    this.onmessage?.({ data: JSON.stringify({ type: "snapshot", data, cols: 80, rows: 24 }) });
  }
  /** Simulate the server dropping the connection (not a clean 1000/4404
   *  shutdown) — triggers the component's real `onclose` handler, which is
   *  what resets `insertReadyRef`. */
  closeAbnormally(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

let instances: FakeWebSocket[] = [];

vi.stubGlobal("WebSocket", FakeWebSocket);

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);

beforeEach(() => {
  instances = [];
  lastTerminal = null;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ port: 4123 }),
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function dispatchInsert(text: string) {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(TERMINAL_INSERT_TEXT_EVENT, { detail: { text } }),
    );
  });
}

describe("TerminalView insert-text queueing", () => {
  it("does not lose an insert dispatched while the socket is CONNECTING", async () => {
    const { default: TerminalView } = await import("@/components/terminal/terminal-view");
    render(<TerminalView terminalId="t1" />);
    await flushMicrotasks();

    const socket = instances[0];
    expect(socket.readyState).toBe(FakeWebSocket.CONNECTING);

    dispatchInsert("hello from a drop");
    // Not lost, but not delivered yet either — no snapshot has landed.
    expect(lastTerminal!.pastes).toHaveLength(0);

    act(() => socket.open());
    act(() => socket.snapshot("prior screen"));

    expect(lastTerminal!.pastes).toEqual(["hello from a drop"]);
  });

  it("delivers a queued insert only AFTER the snapshot has been applied, not merely on open", async () => {
    const { default: TerminalView } = await import("@/components/terminal/terminal-view");
    render(<TerminalView terminalId="t1" />);
    await flushMicrotasks();

    const socket = instances[0];
    dispatchInsert("queued text");

    act(() => socket.open());
    // Socket is OPEN now but no snapshot has arrived — must still be held.
    expect(lastTerminal!.pastes).toHaveLength(0);
    expect(lastTerminal!.resetCalls).toBe(0);

    act(() => socket.snapshot("screen"));

    // The paste must land only once term.reset() (part of snapshot
    // application) has already happened — never before it.
    expect(lastTerminal!.resetCalls).toBe(1);
    expect(lastTerminal!.pastes).toEqual(["queued text"]);
  });

  it("delivers an insert immediately, unqueued, once the socket is OPEN and settled", async () => {
    const { default: TerminalView } = await import("@/components/terminal/terminal-view");
    render(<TerminalView terminalId="t1" />);
    await flushMicrotasks();

    const socket = instances[0];
    act(() => socket.open());
    act(() => socket.snapshot("screen"));
    expect(lastTerminal!.pastes).toHaveLength(0); // nothing queued yet

    dispatchInsert("typed later");

    expect(lastTerminal!.pastes).toEqual(["typed later"]);
  });

  it("delivers a queued insert at most once", async () => {
    const { default: TerminalView } = await import("@/components/terminal/terminal-view");
    render(<TerminalView terminalId="t1" />);
    await flushMicrotasks();

    const socket = instances[0];
    dispatchInsert("only once");
    act(() => socket.open());
    act(() => socket.snapshot("screen"));
    expect(lastTerminal!.pastes).toEqual(["only once"]);

    // A second, unrelated snapshot on the same connection must not re-deliver
    // whatever was already flushed and cleared.
    act(() => socket.snapshot("screen again"));
    expect(lastTerminal!.pastes).toEqual(["only once"]);
  });

  it("never appends a trailing newline to the inserted text", async () => {
    const { default: TerminalView } = await import("@/components/terminal/terminal-view");
    render(<TerminalView terminalId="t1" />);
    await flushMicrotasks();

    const socket = instances[0];
    act(() => socket.open());
    act(() => socket.snapshot("screen"));

    dispatchInsert("no newline please");
    expect(lastTerminal!.pastes[0]).toBe("no newline please");
    expect(lastTerminal!.pastes[0].endsWith("\n")).toBe(false);
  });

  it("accumulates two inserts queued while disconnected instead of the second overwriting the first", async () => {
    // Regression guard: pendingInsertRef used to be a single `string | null`
    // slot that a second queued insert simply clobbered, silently losing the
    // first (contradicting the abutting-drops fix in buildInsertText, whose
    // whole point is that two consecutive drops must both land).
    const { default: TerminalView } = await import("@/components/terminal/terminal-view");
    render(<TerminalView terminalId="t1" />);
    await flushMicrotasks();

    const socket = instances[0];
    dispatchInsert("first drop");
    dispatchInsert("second drop");
    // Neither delivered yet — no snapshot has landed on this connection.
    expect(lastTerminal!.pastes).toHaveLength(0);

    act(() => socket.open());
    act(() => socket.snapshot("screen"));

    // Both survive, space-separated, in drop order — one paste call.
    expect(lastTerminal!.pastes).toEqual(["first drop second drop"]);
  });

  it("resets insertReadyRef on close so a stale ready cannot leak into the next connection's pre-snapshot window", async () => {
    vi.useFakeTimers();
    try {
      const { default: TerminalView } = await import("@/components/terminal/terminal-view");
      render(<TerminalView terminalId="t1" />);
      await flushMicrotasks();

      const socket1 = instances[0];
      act(() => socket1.open());
      act(() => socket1.snapshot("screen"));
      expect(lastTerminal!.resetCalls).toBe(1);

      // Drop the connection abnormally (not a clean 1000/4404 shutdown) so a
      // reconnect is scheduled.
      act(() => socket1.closeAbnormally());

      // Advance past the reconnect backoff so a second socket is created.
      await act(async () => {
        vi.advanceTimersByTime(1500);
      });
      await flushMicrotasks();

      const socket2 = instances[1];
      expect(socket2).toBeDefined();

      // Socket 2 is OPEN, but has NOT yet replayed its own snapshot. If
      // `insertReadyRef` were not reset on close, it would still read `true`
      // from socket 1's connection, and this insert would be delivered
      // immediately instead of waiting for socket 2's own snapshot.
      act(() => socket2.open());
      dispatchInsert("should stay queued");
      expect(lastTerminal!.pastes).not.toContain("should stay queued");

      act(() => socket2.snapshot("screen 2"));
      expect(lastTerminal!.pastes).toContain("should stay queued");
    } finally {
      vi.useRealTimers();
    }
  });
});
