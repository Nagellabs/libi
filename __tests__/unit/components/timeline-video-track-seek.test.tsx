// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TimelineVideoTrack } from "@/components/preview/timeline-video-track";

const scenes = [
  { id: "s1", name: "Intro", type: "canvas" as const },
  { id: "s2", name: "Main", type: "canvas" as const },
];

describe("TimelineVideoTrack click-to-seek", () => {
  it("calls onSeekFrame with a frame based on click position within the track", () => {
    const onSelect = vi.fn();
    const onSeekFrame = vi.fn();

    // Give the track container a mocked bounding rect so we can compute the frame.
    // The container is the div[data-testid="timeline-video-track"].
    // Mock getBoundingClientRect at the element level.
    const mockGetBoundingClientRect = vi.fn().mockReturnValue({
      left: 0,
      width: 1000,
      top: 0,
      bottom: 28,
      right: 1000,
      height: 28,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    const { container } = render(
      <TimelineVideoTrack
        scenes={scenes}
        fps={30}
        totalFrames={300}
        durations={{ s1: 5, s2: 5 }}
        selectedId={null}
        onSelect={onSelect}
        onContextMenu={() => {}}
        onSeekFrame={onSeekFrame}
      />,
    );

    const track = screen.getByTestId("timeline-video-track");
    Object.defineProperty(track, "getBoundingClientRect", {
      value: mockGetBoundingClientRect,
      writable: true,
    });

    // Click the first scene block at clientX=250. Container left=0, width=1000.
    // ratio = 250/1000 = 0.25. frame = round(0.25 * 299) = round(74.75) = 75.
    const block = screen.getByTestId("video-block-s1");
    fireEvent.click(block, { clientX: 250 });

    expect(onSelect).toHaveBeenCalledWith("s1");
    expect(onSeekFrame).toHaveBeenCalledWith(75);
  });

  it("still works without onSeekFrame prop (no crash)", () => {
    const onSelect = vi.fn();
    render(
      <TimelineVideoTrack
        scenes={scenes}
        fps={30}
        totalFrames={300}
        durations={{ s1: 5, s2: 5 }}
        selectedId={null}
        onSelect={onSelect}
        onContextMenu={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("video-block-s1"), { clientX: 250 });
    expect(onSelect).toHaveBeenCalledWith("s1");
  });
});
