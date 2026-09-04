// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRef } from "react";
import { usePlayheadScrub } from "@/hooks/preview/use-playhead-scrub";

/** Mount the hook against a lane element spanning x = 0…1000. */
function setup(onScrub: (frame: number) => void, onDragPointerX?: (x: number) => void) {
  const lane = document.createElement("div");
  lane.getBoundingClientRect = () =>
    ({ left: 0, width: 1000, top: 0, height: 20, right: 1000, bottom: 20, x: 0, y: 0, toJSON: () => {} }) as DOMRect;
  document.body.appendChild(lane);
  return renderHook(() => {
    const laneRef = useRef<HTMLDivElement | null>(lane);
    return usePlayheadScrub({ laneRef, totalFrames: 100, onScrub, onDragPointerX });
  });
}

describe("usePlayheadScrub edge-scroll support", () => {
  it("exposes scrubTo, which seeks the frame under a client x", () => {
    const onScrub = vi.fn();
    const { result } = setup(onScrub);
    act(() => {
      result.current.scrubTo(500);
    });
    // Halfway across a 1000px lane of 100 frames.
    expect(onScrub).toHaveBeenCalledTimes(1);
    expect(onScrub.mock.calls[0][0]).toBeGreaterThan(45);
    expect(onScrub.mock.calls[0][0]).toBeLessThan(55);
  });

  it("reports the pointer x on every move while a drag is held", () => {
    const onDragPointerX = vi.fn();
    const { result } = setup(vi.fn(), onDragPointerX);
    const target = { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() };
    act(() => {
      result.current.onPointerDown({
        button: 0, clientX: 100, pointerId: 1, currentTarget: target,
        preventDefault: () => {}, stopPropagation: () => {},
      } as never);
    });
    act(() => {
      result.current.onPointerMove({ buttons: 1, clientX: 990, pointerId: 1 } as never);
    });
    expect(onDragPointerX).toHaveBeenLastCalledWith(990);
  });

  it("does not report a pointer x when no drag is held", () => {
    const onDragPointerX = vi.fn();
    const { result } = setup(vi.fn(), onDragPointerX);
    act(() => {
      result.current.onPointerMove({ buttons: 0, clientX: 990, pointerId: 1 } as never);
    });
    expect(onDragPointerX).not.toHaveBeenCalled();
  });
});
