// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OverlayBar, type OverlayBarModel } from "@/components/preview/overlay-bar";
import type { LaneView } from "@/lib/preview/lane-bar-geometry";

const view: LaneView = { trackWidth: 1000, totalFrames: 300, fps: 30 };
const bar: OverlayBarModel = {
  id: "o1",
  kind: "text",
  startTime: 0,
  duration: 5,
  subLane: 0,
  selected: false,
  hidden: false,
  locked: false,
};

describe("OverlayBar click-to-seek", () => {
  it("fires onSeekToTime with the mousedown clientX on a no-move click", () => {
    const onSelect = vi.fn();
    const onSeekToTime = vi.fn();
    render(
      <OverlayBar
        bar={bar}
        view={view}
        subLaneHeight={28}
        onSelect={onSelect}
        onCommitTiming={() => {}}
        onCrossRow={() => {}}
        onSeekToTime={onSeekToTime}
      />,
    );
    const el = screen.getByTestId("overlay-bar-o1");
    // Mousedown at clientX=200, then mouseup at same x (no move)
    fireEvent.mouseDown(el, { clientX: 200, clientY: 10 });
    fireEvent.mouseUp(window, { clientX: 200, clientY: 10 });
    // Plan M4.3: onSelect now carries the click's keyboard modifiers.
    expect(onSelect).toHaveBeenCalledWith("o1", { shift: false, meta: false });
    expect(onSeekToTime).toHaveBeenCalledWith(200);
  });

  it("does NOT fire onSeekToTime when the mouse moved > 3px", () => {
    const onSelect = vi.fn();
    const onSeekToTime = vi.fn();
    render(
      <OverlayBar
        bar={bar}
        view={view}
        subLaneHeight={28}
        onSelect={onSelect}
        onCommitTiming={() => {}}
        onCrossRow={() => {}}
        onSeekToTime={onSeekToTime}
      />,
    );
    const el = screen.getByTestId("overlay-bar-o1");
    // Mousedown, then move > 3px, then mouseup
    fireEvent.mouseDown(el, { clientX: 200, clientY: 10 });
    fireEvent.mouseMove(window, { clientX: 210, clientY: 10 }); // 10px move
    fireEvent.mouseUp(window, { clientX: 210, clientY: 10 });
    expect(onSeekToTime).not.toHaveBeenCalled();
  });
});
