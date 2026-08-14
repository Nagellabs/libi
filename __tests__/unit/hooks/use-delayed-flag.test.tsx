// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDelayedFlag } from "@/hooks/use-delayed-flag";

/**
 * The hook defers a loading skeleton: `true` only after `active` has stayed
 * continuously true for `delayMs`, and back to `false` the INSTANT `active`
 * drops — the reset happens during render (pre-paint), not in an effect.
 */
describe("useDelayedFlag", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays false until delayMs elapses, then flips true", () => {
    const { result } = renderHook(({ active }) => useDelayedFlag(active, 300), {
      initialProps: { active: true },
    });
    expect(result.current).toBe(false);

    act(() => vi.advanceTimersByTime(299));
    expect(result.current).toBe(false);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("never flips for a load faster than delayMs (no skeleton flash)", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useDelayedFlag(active, 300),
      { initialProps: { active: true } },
    );
    act(() => vi.advanceTimersByTime(100));
    rerender({ active: false });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(false);
  });

  it("resets to false the instant active drops", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useDelayedFlag(active, 300),
      { initialProps: { active: true } },
    );
    act(() => vi.advanceTimersByTime(300));
    expect(result.current).toBe(true);

    rerender({ active: false });
    expect(result.current).toBe(false);
  });

  it("requires a fresh continuous delayMs after a false→true bounce", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useDelayedFlag(active, 300),
      { initialProps: { active: true } },
    );
    act(() => vi.advanceTimersByTime(300));
    expect(result.current).toBe(true);

    rerender({ active: false });
    rerender({ active: true });
    expect(result.current).toBe(false);

    act(() => vi.advanceTimersByTime(299));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });
});
