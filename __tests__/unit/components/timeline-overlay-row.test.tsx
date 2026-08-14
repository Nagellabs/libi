// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TimelineOverlayRow } from "@/components/preview/timeline-overlay-row";
import type { LayerRowVM } from "@/lib/overlays/layers-view-model";

const row: LayerRowVM = {
  group: "captions",
  subLaneCount: 1,
  layers: [{ id: "o1", kind: "text", subLane: 0, z: 0, selected: false, hidden: false, locked: false }],
};

const textRowForCaption: LayerRowVM = {
  group: "captions",
  subLaneCount: 1,
  layers: [{ id: "o2", kind: "text", subLane: 0, z: 0, selected: false, hidden: false, locked: false }],
};

describe("TimelineOverlayRow", () => {
  it("does NOT render the in-lane add-caption button (button has been removed)", () => {
    render(
      <TimelineOverlayRow
        row={textRowForCaption}
        timingById={{ o2: { startTime: 0, duration: 1 } }}
        view={{ trackWidth: 100, totalFrames: 30, fps: 30 }}
        collapsed={false}
        onSelect={() => {}}
        onCommitTiming={() => {}}
        onCrossRow={() => {}}
        rowGroup="captions"
      />,
    );
    expect(screen.queryByTestId(/add-caption/)).toBeNull();
  });
  it("renders only the lane (no internal label button)", () => {
    render(
      <TimelineOverlayRow
        row={row}
        timingById={{ o1: { startTime: 0, duration: 1 } }}
        view={{ trackWidth: 100, totalFrames: 30, fps: 30 }}
        collapsed={false}
        onSelect={() => {}}
        onCommitTiming={() => {}}
        onCrossRow={() => {}}
        rowGroup="captions"
      />,
    );
    // The old left label button is gone; the lane + bar remain.
    expect(screen.queryByTitle("Collapse row")).toBeNull();
    expect(screen.getByTestId("overlay-bar-o1")).toBeInTheDocument();
  });

  it("shows a compact summary when collapsed", () => {
    render(
      <TimelineOverlayRow
        row={row}
        timingById={{ o1: { startTime: 0, duration: 1 } }}
        view={{ trackWidth: 100, totalFrames: 30, fps: 30 }}
        collapsed
        onSelect={() => {}}
        onCommitTiming={() => {}}
        onCrossRow={() => {}}
        rowGroup="captions"
      />,
    );
    expect(screen.getByTestId("overlay-lane-captions")).toHaveTextContent("captions ×1");
  });
});
