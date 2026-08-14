// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TimelineVideoTrack } from "@/components/preview/timeline-video-track";

const scenes = [
  { id: "s1", name: "Base video — ride", type: "canvas" as const },
  { id: "s2", name: "Outro", type: "canvas" as const },
];

describe("TimelineVideoTrack", () => {
  it("renders one block per scene with the name shown once", () => {
    render(
      <TimelineVideoTrack
        scenes={scenes}
        fps={30}
        totalFrames={90}
        durations={{ s1: 2, s2: 1 }}
        selectedId={null}
        onSelect={() => {}}
        onContextMenu={() => {}}
      />,
    );
    expect(screen.getByTestId("video-block-s1")).toHaveTextContent("Base video — ride");
    expect(screen.getAllByText("Base video — ride")).toHaveLength(1);
    expect(screen.getByTestId("video-block-s2")).toBeInTheDocument();
  });

  it("selects on click and opens the menu on right-click", () => {
    const onSelect = vi.fn();
    const onContextMenu = vi.fn();
    render(
      <TimelineVideoTrack
        scenes={scenes}
        fps={30}
        totalFrames={90}
        durations={{ s1: 2, s2: 1 }}
        selectedId="s2"
        onSelect={onSelect}
        onContextMenu={onContextMenu}
      />,
    );
    fireEvent.click(screen.getByTestId("video-block-s1"));
    expect(onSelect).toHaveBeenCalledWith("s1");
    fireEvent.contextMenu(screen.getByTestId("video-block-s1"));
    expect(onContextMenu).toHaveBeenCalled();
    expect(screen.getByTestId("video-block-s2").className).toContain("border-primary");
  });
});
