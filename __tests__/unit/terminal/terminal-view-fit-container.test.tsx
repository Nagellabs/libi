// @vitest-environment jsdom
/**
 * Pins the container structure that fixes the bottom-row-clipped bug: xterm's
 * own FitAddon.proposeDimensions() reads
 * `getComputedStyle(term.element.parentElement)` for the available height —
 * i.e. the element xterm opens INTO's parent — and only subtracts padding it
 * finds on `term.element` itself. So if the ~8px "breathing room" padding
 * lived on (or above) the element passed to `term.open()`, FitAddon proposes
 * rows/cols sized for more space than the frame actually has, and the last
 * row is clipped under the bottom edge. The fix keeps that padding on a
 * wrapper OUTSIDE the element xterm opens into, and that inner element
 * itself carries no padding of its own — see the comment above the return
 * statement in terminal-view.tsx.
 *
 * xterm, its addons, WebSocket, fetch and ResizeObserver are faked here (see
 * terminal-view-insert-queue.test.tsx for why); the component itself — and
 * the real DOM it renders — is not.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

class FakeTerminal {
  cols = 80;
  rows = 24;
  options: { theme?: unknown } = {};
  openedWith: HTMLElement | null = null;
  open(el: HTMLElement): void {
    this.openedWith = el;
  }
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
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@/components/terminal/terminal-view.css", () => ({}));

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

  constructor(public url: string) {}
  send(): void {}
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

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
  lastTerminal = null;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ port: 4123 }) }));
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

describe("TerminalView container structure (FitAddon measurement)", () => {
  it("opens xterm in an unpadded inner element whose parent carries the padding", async () => {
    const { default: TerminalView } = await import("@/components/terminal/terminal-view");
    const { container } = render(<TerminalView terminalId="t1" />);
    await flushMicrotasks();

    const opened = lastTerminal!.openedWith;
    expect(opened).not.toBeNull();

    // The element xterm draws into must carry no padding of its own — any
    // padding here would make FitAddon propose rows/cols sized for more
    // space than the frame actually has (see the file-level comment).
    expect(opened!.className).not.toMatch(/\bp-\d/);

    // The padding — and the scrollbar scoping class — lives one
    // level up, on the wrapper FitAddon reads via
    // `term.element.parentElement`.
    const wrapper = opened!.parentElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper!.className).toMatch(/\bp-2\b/);
    expect(wrapper!.className).toMatch(/\blibi-terminal\b/);

    // Sanity: that wrapper is the outer element TerminalView renders, not
    // some unrelated ancestor further up.
    expect(container.firstElementChild).toBe(wrapper);
  });

  it("keeps the __xterm test hook on the element xterm actually opened into", async () => {
    const { default: TerminalView } = await import("@/components/terminal/terminal-view");
    render(<TerminalView terminalId="t1" />);
    await flushMicrotasks();

    const opened = lastTerminal!.openedWith as (HTMLElement & { __xterm?: unknown }) | null;
    expect(opened).not.toBeNull();
    expect(opened!.__xterm).toBe(lastTerminal);
  });
});
