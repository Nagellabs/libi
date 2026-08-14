// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { OverlayBar, type OverlayBarModel } from "@/components/preview/overlay-bar";
import type { LaneView } from "@/lib/preview/lane-bar-geometry";

const view: LaneView = { trackWidth: 1000, totalFrames: 300, fps: 30 };

function makeBar(overrides?: Partial<OverlayBarModel>): OverlayBarModel {
  return {
    id: "o1",
    kind: "text",
    startTime: 0,
    duration: 5,
    subLane: 0,
    selected: false,
    hidden: false,
    locked: false,
    ...overrides,
  };
}

describe("OverlayBar label display", () => {
  it("renders the label when provided (not the kind)", () => {
    render(
      <OverlayBar
        bar={makeBar({ label: "Hello world" })}
        view={view}
        subLaneHeight={28}
        onSelect={() => {}}
        onCommitTiming={() => {}}
        onCrossRow={() => {}}
      />,
    );
    const bar = screen.getByTestId("overlay-bar-o1");
    expect(bar).toHaveTextContent("Hello world");
    expect(bar).not.toHaveTextContent("text");
  });

  it("renders the kind when no label is provided", () => {
    render(
      <OverlayBar
        bar={makeBar()}
        view={view}
        subLaneHeight={28}
        onSelect={() => {}}
        onCommitTiming={() => {}}
        onCrossRow={() => {}}
      />,
    );
    expect(screen.getByTestId("overlay-bar-o1")).toHaveTextContent("text");
  });
});
