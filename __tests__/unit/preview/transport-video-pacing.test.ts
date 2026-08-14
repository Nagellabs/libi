// @vitest-environment jsdom
/**
 * useTransport — Phase-2 video-pacing clamp.
 *
 * The wall-clock playhead must not run more than PACE_LEAD_S ahead of the
 * active video's REAL decode position (the `getActiveVideoTime` probe). This
 * keeps the canvas from showing frames the decoder hasn't produced and stops
 * the controller's 0.45s drift-seek from firing mid-cold-warmup.
 *
 * Covers:
 *  - no probe → pure wall-clock advance (legacy behavior)
 *  - probe null (canvas scene) → pure wall-clock advance
 *  - lagging video → counter is capped near videoTime + PACE_LEAD_S
 *  - video catches up → counter resumes advancing
 *  - genuinely stuck video → counter escapes after MAX_PACE_HOLD_MS (no freeze)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useTransport,
  PACE_LEAD_S,
  MAX_PACE_HOLD_MS,
} from "@/hooks/preview/use-transport";

describe("useTransport video-pacing clamp", () => {
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

  it("no probe → advances by pure wall-clock", () => {
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 10000, fps: 30 }),
    );
    act(() => result.current.play());
    act(() => { vi.advanceTimersByTime(500); });
    // ~500ms at 30fps ≈ 15 frames; just assert it advanced well past the cap.
    expect(result.current.getFrame()).toBeGreaterThan(8);
  });

  it("probe returning null (canvas scene) → pure wall-clock", () => {
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 10000, fps: 30, getActiveVideoTime: () => null }),
    );
    act(() => result.current.play());
    act(() => { vi.advanceTimersByTime(500); });
    expect(result.current.getFrame()).toBeGreaterThan(8);
  });

  it("lagging video → counter capped near videoTime + PACE_LEAD_S", () => {
    // Video stuck at 0s (cold). Cap = floor((0 + 0.15) * 30) = 4 frames.
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 10000, fps: 30, getActiveVideoTime: () => 0 }),
    );
    act(() => result.current.play());
    act(() => { vi.advanceTimersByTime(500); }); // well under MAX_PACE_HOLD_MS
    const cap = Math.floor((0 + PACE_LEAD_S) * 30);
    expect(result.current.getFrame()).toBeLessThanOrEqual(cap);
    expect(result.current.getFrame()).toBeGreaterThan(0); // advanced up to the cap, didn't freeze at 0
  });

  it("video catches up → counter resumes advancing past the old cap", () => {
    let videoTime = 0; // cold
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 10000, fps: 30, getActiveVideoTime: () => videoTime }),
    );
    act(() => result.current.play());
    act(() => { vi.advanceTimersByTime(300); });
    const heldCap = Math.floor((0 + PACE_LEAD_S) * 30);
    expect(result.current.getFrame()).toBeLessThanOrEqual(heldCap);

    // Decoder warms and runs ahead of the playhead.
    videoTime = 5;
    act(() => { vi.advanceTimersByTime(300); });
    expect(result.current.getFrame()).toBeGreaterThan(heldCap);
  });

  it("genuinely stuck video → counter escapes after MAX_PACE_HOLD_MS (no freeze)", () => {
    // Video frozen at 0 forever (e.g. autoplay denied). The clamp must give up
    // after the hold cap so the counter can't be frozen indefinitely.
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 100000, fps: 30, getActiveVideoTime: () => 0 }),
    );
    act(() => result.current.play());
    const cap = Math.floor((0 + PACE_LEAD_S) * 30);

    // Within the hold window → still capped.
    act(() => { vi.advanceTimersByTime(MAX_PACE_HOLD_MS - 200); });
    expect(result.current.getFrame()).toBeLessThanOrEqual(cap);

    // Past the hold cap → wall-clock takes over, counter advances past the cap.
    act(() => { vi.advanceTimersByTime(800); });
    expect(result.current.getFrame()).toBeGreaterThan(cap);
  });
});
