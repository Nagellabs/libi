// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { usePreviewPlayer } from "@/components/social/music/use-preview-player";

function Player({ id }: { id: string }) {
  const { audioRef, audioProps, playing } = usePreviewPlayer();
  return (
    <div>
      <audio data-testid={`audio-${id}`} ref={audioRef} {...audioProps} />
      <span data-testid={`state-${id}`}>{playing ? "playing" : "stopped"}</span>
    </div>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("usePreviewPlayer — one preview at a time across the app (M10)", () => {
  it("when one instance starts playing, every other stops", () => {
    const paused: HTMLMediaElement[] = [];
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
      paused.push(this);
    });
    render(
      <>
        <Player id="a" />
        <Player id="b" />
      </>,
    );
    const a = screen.getByTestId("audio-a") as HTMLAudioElement;
    const b = screen.getByTestId("audio-b") as HTMLAudioElement;
    fireEvent.play(a);
    expect(screen.getByTestId("state-a")).toHaveTextContent("playing");
    expect(paused).not.toContain(a);
    paused.length = 0;
    fireEvent.play(b);
    expect(screen.getByTestId("state-b")).toHaveTextContent("playing");
    expect(screen.getByTestId("state-a")).toHaveTextContent("stopped");
    expect(paused).toContain(a);
    expect(paused).not.toContain(b);
  });

  it("an unmounted player is no longer stopped by others", () => {
    const paused: HTMLMediaElement[] = [];
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
      paused.push(this);
    });
    const { rerender } = render(
      <>
        <Player id="a" />
        <Player id="b" />
      </>,
    );
    const a = screen.getByTestId("audio-a");
    rerender(<Player id="b" />);
    paused.length = 0;
    fireEvent.play(screen.getByTestId("audio-b"));
    expect(paused).not.toContain(a);
  });
});
