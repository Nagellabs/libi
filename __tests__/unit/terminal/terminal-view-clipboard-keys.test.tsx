// @vitest-environment jsdom
/**
 * Clipboard shortcuts in the inline terminal (components/terminal/terminal-view.tsx).
 *
 * xterm turns Ctrl+V into ^V and cancels the key, so on Windows — where Ctrl+V is
 * paste — nothing could be pasted into a setup terminal, a provider key's hidden
 * prompt included. TerminalView hands xterm a key handler that leaves the paste to
 * the browser and copies a selection on Ctrl+C.
 *
 * xterm is faked, as in the other TerminalView tests: what is under test is the
 * handler TerminalView attaches and what it does with each key. That the browser
 * then fires a paste event xterm reads is xterm's and Chromium's own behaviour.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

type KeyHandler = (ev: KeyboardEvent) => boolean;

class FakeTerminal {
  cols = 80;
  rows = 24;
  options: { theme?: unknown } = {};
  keyHandler: KeyHandler | null = null;
  selection = "";
  cleared = 0;
  open(): void {}
  loadAddon(): void {}
  focus(): void {}
  refresh(): void {}
  resize(): void {}
  dispose(): void {}
  reset(): void {}
  write(): void {}
  paste(): void {}
  onScroll() {
    return { dispose() {} };
  }
  onData() {
    return { dispose() {} };
  }
  attachCustomKeyEventHandler(handler: KeyHandler): void {
    this.keyHandler = handler;
  }
  hasSelection(): boolean {
    return this.selection.length > 0;
  }
  getSelection(): string {
    return this.selection;
  }
  clearSelection(): void {
    this.selection = "";
    this.cleared++;
  }
}

let term: FakeTerminal | null = null;

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor() {
      term = new FakeTerminal();
      return term;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit(): void {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
vi.stubGlobal("WebSocket", class { static OPEN = 1; readyState = 0; close() {} send() {} });

const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);

beforeEach(() => {
  term = null;
  writeText.mockClear();
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function key(type: "keydown" | "keypress" | "keyup", code: "KeyV" | "KeyC", mods: { shiftKey?: boolean; altKey?: boolean } = {}) {
  return {
    type,
    code,
    keyCode: code === "KeyV" ? 86 : 67,
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

async function mount(platform: string) {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  const { default: TerminalView } = await import("@/components/terminal/terminal-view");
  render(<TerminalView terminalId="t1" />);
  expect(term?.keyHandler).toBeTypeOf("function");
  return term!;
}

describe("TerminalView clipboard shortcuts", () => {
  it("on Windows, Ctrl+V and Ctrl+Shift+V are left to the browser to paste: xterm skips them and nothing cancels them", async () => {
    const t = await mount("Win32");
    for (const ev of [key("keydown", "KeyV"), key("keypress", "KeyV"), key("keyup", "KeyV"), key("keydown", "KeyV", { shiftKey: true })]) {
      expect(t.keyHandler!(ev)).toBe(false);
      expect(ev.preventDefault).not.toHaveBeenCalled();
    }
  });

  it("on Windows, Ctrl+C with text selected copies it once and clears the selection when the copy landed, so the next Ctrl+C interrupts", async () => {
    const t = await mount("Win32");
    t.selection = "error: something failed";
    const down = key("keydown", "KeyC");
    expect(t.keyHandler!(down)).toBe(false);
    expect(down.preventDefault).toHaveBeenCalled();
    expect(t.keyHandler!(key("keyup", "KeyC"))).toBe(false);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("error: something failed");
    await act(async () => undefined);
    expect(t.cleared).toBe(1);
    expect(t.keyHandler!(key("keydown", "KeyC"))).toBe(true);
  });

  it("a copy the clipboard refuses keeps the selection, so it can be copied again", async () => {
    const t = await mount("Win32");
    writeText.mockRejectedValueOnce(new Error("Document is not focused."));
    t.selection = "keep me";
    expect(t.keyHandler!(key("keydown", "KeyC"))).toBe(false);
    await act(async () => undefined);
    expect(t.cleared).toBe(0);
    expect(t.selection).toBe("keep me");
  });

  it("without the async clipboard (an insecure page) Ctrl+C stays the interrupt even with text selected", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const t = await mount("Win32");
    t.selection = "selected";
    expect(t.keyHandler!(key("keydown", "KeyC"))).toBe(true);
    expect(t.keyHandler!(key("keydown", "KeyV"))).toBe(false);
  });

  it("on Windows, Ctrl+C with nothing selected and AltGr+V (Ctrl+Alt) stay xterm's", async () => {
    const t = await mount("Win32");
    expect(t.keyHandler!(key("keydown", "KeyC"))).toBe(true);
    expect(t.keyHandler!(key("keydown", "KeyV", { altKey: true }))).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("on a Mac nothing changes: ⌘V already pastes, and Ctrl+V stays ^V", async () => {
    const t = await mount("MacIntel");
    t.selection = "selected";
    expect(t.keyHandler!(key("keydown", "KeyV"))).toBe(true);
    expect(t.keyHandler!(key("keydown", "KeyC"))).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });
});
