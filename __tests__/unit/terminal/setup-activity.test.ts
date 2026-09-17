import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  __resetSetupActivity,
  noteSetupTerminalClosed,
  noteSetupTerminalOpened,
  onSetupTerminalsSettled,
  setupActivity,
} from "@/lib/terminal/setup-activity";

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

beforeEach(() => {
  __resetSetupActivity();
});

describe("setup terminal activity", () => {
  it("counts every open and close, and how many are open", () => {
    expect(setupActivity()).toEqual({ epoch: 0, live: 0 });
    noteSetupTerminalOpened();
    noteSetupTerminalOpened();
    expect(setupActivity()).toEqual({ epoch: 2, live: 2 });
    noteSetupTerminalClosed();
    expect(setupActivity()).toEqual({ epoch: 3, live: 1 });
    noteSetupTerminalClosed();
    noteSetupTerminalClosed();
    expect(setupActivity()).toEqual({ epoch: 5, live: 0 });
  });

  it("tells a listener once the last setup terminal closed, and not while one is still open", async () => {
    const settled = vi.fn();
    onSetupTerminalsSettled(settled);
    noteSetupTerminalOpened();
    noteSetupTerminalOpened();
    noteSetupTerminalClosed();
    await flushMicrotasks();
    expect(settled).not.toHaveBeenCalled();
    noteSetupTerminalClosed();
    expect(settled).not.toHaveBeenCalled();
    await flushMicrotasks();
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("a surface's terminal replaced by the next one (closed and opened in one call) never reads as settled", async () => {
    const settled = vi.fn();
    onSetupTerminalsSettled(settled);
    noteSetupTerminalOpened();
    noteSetupTerminalClosed();
    noteSetupTerminalOpened();
    await flushMicrotasks();
    expect(settled).not.toHaveBeenCalled();
  });

  it("a listener that throws never stops the others, and an unsubscribed one is not called", async () => {
    const removed = vi.fn();
    const after = vi.fn();
    onSetupTerminalsSettled(() => {
      throw new Error("boom");
    });
    const unsubscribe = onSetupTerminalsSettled(removed);
    onSetupTerminalsSettled(after);
    unsubscribe();
    noteSetupTerminalOpened();
    noteSetupTerminalClosed();
    await flushMicrotasks();
    expect(removed).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(1);
  });
});
