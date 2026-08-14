// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import ToolCallTimer from "@/components/chat/tool-call-timer";

/**
 * The elapsed time is derived from `now` STATE (updated by the interval), not
 * a Date.now() call during render — the display still ticks once a second
 * while running and freezes at completedAt when done.
 */
describe("ToolCallTimer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ticks while running", () => {
    const start = Date.now();
    render(<ToolCallTimer runningAt={start} />);
    expect(screen.getByText(/\(0s\)/)).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(3100));
    expect(screen.getByText(/\(3s\)/)).toBeInTheDocument();
  });

  it("is static once completed — elapsed comes from completedAt", () => {
    const start = Date.now();
    render(<ToolCallTimer runningAt={start} completedAt={start + 65_000} />);
    expect(screen.getByText(/\(1m 5s\)/)).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByText(/\(1m 5s\)/)).toBeInTheDocument();
  });
});
