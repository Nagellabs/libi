// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { KeyframeCurveEditor } from "@/components/preview/keyframe-curve-editor";
import type { Overlay } from "@/lib/engine/types";

/**
 * The curve editor's drag ownership is now STATE (dragHandle), and the
 * re-seed on external easing changes is a render-time adjustment guarded by
 * "not mid-drag". These tests pin the observable pieces: preset commit, the
 * custom seed, and drag start/move/end driving a live cubic-bezier commit.
 */

const setEasingMutate = vi.fn();
vi.mock("@/lib/queries/keyframes", () => ({
  useKeyframeOps: () => ({
    setEasing: { mutate: setEasingMutate },
  }),
}));

function overlayWithKeyframes(): Overlay {
  return {
    id: "ov1",
    kind: "text",
    text: "hi",
    startTime: 0,
    duration: 4,
    rect: { x: 0, y: 0, width: 100, height: 100 },
    z: 1,
    keyframes: {
      opacity: {
        keyframes: [
          { t: 0, value: 0, easing: "ease-in-out" },
          { t: 0.5, value: 1 },
        ],
      },
    },
  } as unknown as Overlay;
}

describe("KeyframeCurveEditor", () => {
  beforeEach(() => {
    setEasingMutate.mockClear();
    vi.useRealTimers();
  });

  it("commits a named preset from the dropdown", () => {
    render(
      <KeyframeCurveEditor
        pieceId="p1"
        overlay={overlayWithKeyframes()}
        t={0}
        fps={30}
        readOnly={false}
      />,
    );
    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "ease-out" } });
    expect(setEasingMutate).toHaveBeenCalledWith(
      expect.objectContaining({ overlayId: "ov1", easing: "ease-out" }),
    );
  });

  it("selecting Custom seeds and commits a cubic-bezier literal", () => {
    render(
      <KeyframeCurveEditor
        pieceId="p1"
        overlay={overlayWithKeyframes()}
        t={0}
        fps={30}
        readOnly={false}
      />,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "custom" } });
    expect(setEasingMutate).toHaveBeenCalledTimes(1);
    expect(setEasingMutate.mock.calls[0][0].easing).toMatch(/^cubic-bezier\(/);
  });

  it("dragging a handle debounce-commits a live cubic-bezier", () => {
    vi.useFakeTimers();
    render(
      <KeyframeCurveEditor
        pieceId="p1"
        overlay={overlayWithKeyframes()}
        t={0}
        fps={30}
        readOnly={false}
      />,
    );
    // Seed a Custom curve so the drag handles render.
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "custom" } });
    setEasingMutate.mockClear();

    const c1 = screen.getByTestId("keyframe-handle-c1");
    const svg = screen.getByTestId("keyframe-curve-svg");

    fireEvent.pointerDown(c1, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(svg, { pointerId: 1 });

    // Pointer-up flushes the pending commit immediately.
    expect(setEasingMutate).toHaveBeenCalled();
    expect(
      setEasingMutate.mock.calls[setEasingMutate.mock.calls.length - 1][0].easing,
    ).toMatch(/^cubic-bezier\(/);
    vi.useRealTimers();
  });

  it("readOnly never commits", () => {
    render(
      <KeyframeCurveEditor
        pieceId="p1"
        overlay={overlayWithKeyframes()}
        t={0}
        fps={30}
        readOnly
      />,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ease-out" } });
    expect(setEasingMutate).not.toHaveBeenCalled();
  });
});
