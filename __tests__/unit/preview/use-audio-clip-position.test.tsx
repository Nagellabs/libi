// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAudioClipPosition } from "@/hooks/preview/use-audio-clip-position";

/**
 * The optimistic hold releases DURING RENDER once the incoming prop provably
 * reflects it (previous-state pattern) — display must never flash back to the
 * stale persisted timing between drag release and the refetch landing.
 */
describe("useAudioClipPosition", () => {
  it("passes the prop through when nothing is held", () => {
    const { result } = renderHook(
      ({ t }) => useAudioClipPosition(t),
      { initialProps: { t: { startTime: 1, duration: 2 } } },
    );
    expect(result.current.display).toEqual({ startTime: 1, duration: 2 });
  });

  it("holds the committed timing until the prop catches up, then releases", () => {
    const { result, rerender } = renderHook(
      ({ t }) => useAudioClipPosition(t),
      { initialProps: { t: { startTime: 1, duration: 2 } } },
    );

    // Drag commit → hold the new timing.
    act(() => result.current.hold({ startTime: 5, duration: 2 }));
    expect(result.current.display).toEqual({ startTime: 5, duration: 2 });

    // A STALE refetch (still the old timing) must NOT flash the bar back.
    rerender({ t: { startTime: 1, duration: 2 } });
    expect(result.current.display).toEqual({ startTime: 5, duration: 2 });

    // The refetch that reflects the commit releases the hold (same values).
    rerender({ t: { startTime: 5, duration: 2 } });
    expect(result.current.display).toEqual({ startTime: 5, duration: 2 });

    // Released: a later external change flows straight through.
    rerender({ t: { startTime: 7, duration: 2 } });
    expect(result.current.display).toEqual({ startTime: 7, duration: 2 });
  });
});
