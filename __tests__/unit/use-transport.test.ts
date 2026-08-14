// @vitest-environment jsdom
/**
 * useTransport — single source of truth for preview playback state.
 * Covers: initial state, seek clamps, play/pause/toggle, raf tick advances
 * frame, end-of-composition stops, totalFrames change preserves in-range
 * frame, speed scales tick advance.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTransport } from "@/hooks/preview/use-transport";

describe("useTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      return setTimeout(() => cb(performance.now()), 16) as unknown as number;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts paused at frame 0", () => {
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 100, fps: 30 }),
    );
    expect(result.current.getFrame()).toBe(0);
    expect(result.current.playing).toBe(false);
    expect(result.current.speed).toBe(1);
  });

  it("seek clamps into [0, totalFrames-1] and preserves play state", () => {
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 10, fps: 30 }),
    );
    act(() => result.current.play());
    expect(result.current.playing).toBe(true);

    act(() => result.current.seek(500));
    expect(result.current.getFrame()).toBe(9);
    // Scrub does NOT auto-pause. The `<video>` element can jump to a new
    // currentTime mid-playback (once the byte-range response lands), so
    // keeping `playing=true` lets the transport resume from the new point
    // without an extra click.
    expect(result.current.playing).toBe(true);

    act(() => result.current.seek(-5));
    expect(result.current.getFrame()).toBe(0);
  });

  it("seek while playing: tick loop picks up the new frame", () => {
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 1000, fps: 30 }),
    );
    act(() => result.current.play());
    act(() => { vi.advanceTimersByTime(300); });
    // At ~300ms, frame is ~9. Now seek far forward mid-play.
    act(() => result.current.seek(500));
    expect(result.current.getFrame()).toBe(500);
    expect(result.current.playing).toBe(true);
    // After more wall time, playback continues from the seeked frame, not
    // the pre-seek frame + 500ms.
    act(() => { vi.advanceTimersByTime(500); });
    expect(result.current.getFrame()).toBeGreaterThanOrEqual(505);
    expect(result.current.getFrame()).toBeLessThanOrEqual(530);
  });

  it("toggle flips play state", () => {
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 10, fps: 30 }),
    );
    act(() => result.current.toggle());
    expect(result.current.playing).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.playing).toBe(false);
  });

  it("raf tick advances the frame while playing", () => {
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 100, fps: 30 }),
    );
    act(() => result.current.play());
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.getFrame()).toBeGreaterThanOrEqual(25);
    expect(result.current.getFrame()).toBeLessThanOrEqual(35);
  });

  it("pauses and resets to 0 when playback reaches the end", () => {
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 5, fps: 30 }),
    );
    act(() => result.current.play());
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.playing).toBe(false);
    expect(result.current.getFrame()).toBe(0);
  });

  it("getFrame() returns 0 when totalFrames is 0 (empty composition, no negative clamp)", () => {
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 0, fps: 30 }),
    );
    // total <= 0 → 0, never the Math.min(raw, total-1) = -1 path.
    expect(result.current.getFrame()).toBe(0);
    // seek is a no-op on an empty comp; getFrame stays clamped at 0.
    act(() => result.current.seek(50));
    expect(result.current.getFrame()).toBe(0);
  });

  it("clamps frame in-range when totalFrames shrinks", () => {
    const { result, rerender } = renderHook(
      ({ total }) => useTransport({ totalFrames: total, fps: 30 }),
      { initialProps: { total: 100 } },
    );
    act(() => result.current.seek(80));
    expect(result.current.getFrame()).toBe(80);

    rerender({ total: 20 });
    expect(result.current.getFrame()).toBe(19);
  });

  it("setSpeed affects tick pace", () => {
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 1000, fps: 30 }),
    );
    act(() => {
      result.current.setSpeed(2);
      result.current.play();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.getFrame()).toBeGreaterThanOrEqual(50);
  });

  it("seek while paused then play resumes from the seeked frame", () => {
    const { result } = renderHook(() => useTransport({ totalFrames: 1000, fps: 30 }));
    act(() => result.current.seek(500));
    expect(result.current.playing).toBe(false);
    act(() => result.current.play());
    act(() => { vi.advanceTimersByTime(500); });
    // advanced ~15 frames from 500 @ 30fps over 500ms
    expect(result.current.getFrame()).toBeGreaterThanOrEqual(505);
    expect(result.current.getFrame()).toBeLessThanOrEqual(530);
  });
});
