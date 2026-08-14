// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createFrameStore } from "@/lib/preview/frame-store";
import { usePlaybackFrame } from "@/hooks/preview/use-playback-frame";

describe("usePlaybackFrame", () => {
  it("returns the current frame and re-renders on change", () => {
    const store = createFrameStore(0);
    const { result } = renderHook(() => usePlaybackFrame(store));
    expect(result.current).toBe(0);
    act(() => store.set(7));
    expect(result.current).toBe(7);
  });

  it("does not re-render when set() is a no-op (same value)", () => {
    const store = createFrameStore(4);
    const renders = vi.fn();
    renderHook(() => {
      renders();
      return usePlaybackFrame(store);
    });
    const before = renders.mock.calls.length;
    act(() => store.set(4)); // no-op
    expect(renders.mock.calls.length).toBe(before);
  });
});
