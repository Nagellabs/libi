// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TimelineOverlayRow } from "@/components/preview/timeline-overlay-row";
import type { LayerRowVM } from "@/lib/overlays/layers-view-model";

const textRow: LayerRowVM = {
  group: "captions",
  subLaneCount: 1,
  layers: [{ id: "o1", kind: "text", subLane: 0, z: 0, selected: false, hidden: false, locked: false }],
};

const stickerRow: LayerRowVM = {
  group: "stickers",
  subLaneCount: 1,
  layers: [{ id: "i1", kind: "image", subLane: 0, z: 0, selected: false, hidden: false, locked: false }],
};

const view = { trackWidth: 100, totalFrames: 30, fps: 30 };

describe("TimelineOverlayRow inline add-caption (removed)", () => {
  it("text row does NOT render an inline + button (button has been removed)", () => {
    render(
      <TimelineOverlayRow
        row={textRow}
        timingById={{ o1: { startTime: 0, duration: 1 } }}
        view={view}
        collapsed={false}
        onSelect={() => {}}
        onCommitTiming={() => {}}
        onCrossRow={() => {}}
        rowGroup="captions"
      />,
    );
    expect(screen.queryByTestId("add-caption-captions")).toBeNull();
  });

  it("non-text row also does NOT render the inline + (never did for non-text)", () => {
    render(
      <TimelineOverlayRow
        row={stickerRow}
        timingById={{ i1: { startTime: 0, duration: 1 } }}
        view={view}
        collapsed={false}
        onSelect={() => {}}
        onCommitTiming={() => {}}
        onCrossRow={() => {}}
        rowGroup="stickers"
      />,
    );
    expect(screen.queryByTestId("add-caption-stickers")).toBeNull();
  });
});
