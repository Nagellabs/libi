// @vitest-environment jsdom
/**
 * How TerminalView reacts when its socket closes: a session the server no
 * longer has (close code 4404 — reaped, replaced or already exited while no
 * view was attached) is reported through the optional `onSessionGone`, while
 * a clean shell exit is still reported through `onExited` only. A view that
 * passes no `onSessionGone` (the chat terminal panel) keeps its old behaviour:
 * it stops quietly, reports no exit and does not reconnect.
 *
 * xterm, its addons, WebSocket, fetch and ResizeObserver are faked (see
 * terminal-view-insert-queue.test.tsx for why); the component is the real one.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

class FakeTerminal {
  cols = 80;
  rows = 24;
  options: { theme?: unknown } = {};
  open(): void {}
  loadAddon(): void {}
  focus(): void {}
  refresh(): void {}
  resize(): void {}
  dispose(): void {}
  reset(): void {}
  paste(): void {}
  write(_data: unknown, cb?: () => void): void {
    cb?.();
  }
  onScroll(): { dispose(): void } {
    return { dispose() {} };
  }
  attachCustomKeyEventHandler(): void {}
  onData(): { dispose(): void } {
    return { dispose() {} };
  }
}

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor() {
      return new FakeTerminal();
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit(): void {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

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

  constructor(public url: string) {
    instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  message(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverClose(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

let instances: FakeWebSocket[] = [];
vi.stubGlobal("WebSocket", FakeWebSocket);
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  },
);

beforeEach(() => {
  instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ port: 4123 }) }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitPastEveryReconnect() {
  await act(async () => {
    vi.advanceTimersByTime(30_000);
  });
  await flushMicrotasks();
}

describe("TerminalView when its session closes", () => {
  it("reports a missing session (4404) through onSessionGone, not onExited, and does not reconnect", async () => {
    const { default: TerminalView } = await import("@/components/terminal/terminal-view");
    const onExited = vi.fn();
    const onSessionGone = vi.fn();
    render(<TerminalView terminalId="t1" onExited={onExited} onSessionGone={onSessionGone} />);
    await flushMicrotasks();

    act(() => instances[0].serverClose(4404));

    expect(onSessionGone).toHaveBeenCalledTimes(1);
    expect(onExited).not.toHaveBeenCalled();
    await waitPastEveryReconnect();
    expect(instances).toHaveLength(1);
  });

  it("without onSessionGone (the chat panel) a 4404 still stops quietly: no exit reported, no reconnect", async () => {
    const { default: TerminalView } = await import("@/components/terminal/terminal-view");
    const onExited = vi.fn();
    render(<TerminalView terminalId="t1" onExited={onExited} />);
    await flushMicrotasks();

    act(() => instances[0].open());
    act(() => instances[0].serverClose(4404));

    expect(onExited).not.toHaveBeenCalled();
    await waitPastEveryReconnect();
    expect(instances).toHaveLength(1);
  });

  it("a shell that exits cleanly reports onExited and never onSessionGone", async () => {
    const { default: TerminalView } = await import("@/components/terminal/terminal-view");
    const onExited = vi.fn();
    const onSessionGone = vi.fn();
    render(<TerminalView terminalId="t1" onExited={onExited} onSessionGone={onSessionGone} />);
    await flushMicrotasks();

    act(() => instances[0].open());
    act(() => instances[0].message({ type: "exit", exitCode: 3 }));
    act(() => instances[0].serverClose(1000));

    expect(onExited).toHaveBeenCalledWith(3);
    expect(onSessionGone).not.toHaveBeenCalled();
    await waitPastEveryReconnect();
    expect(instances).toHaveLength(1);
  });

  it("a dropped connection reconnects and is not reported as a missing session", async () => {
    const { default: TerminalView } = await import("@/components/terminal/terminal-view");
    const onSessionGone = vi.fn();
    render(<TerminalView terminalId="t1" onSessionGone={onSessionGone} />);
    await flushMicrotasks();

    act(() => instances[0].open());
    act(() => instances[0].serverClose(1006));
    await waitPastEveryReconnect();

    expect(instances.length).toBeGreaterThan(1);
    expect(onSessionGone).not.toHaveBeenCalled();
  });
});
