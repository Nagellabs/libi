// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

let catalogData: unknown;
const catalogCalls: Array<{ platform: string; q?: string }> = [];
vi.mock("@/lib/queries/social-music", () => ({
  useMusicCatalog: (platform: string, _accountId: string, q?: string) => {
    catalogCalls.push({ platform, q });
    return { data: catalogData, isLoading: catalogData === undefined, isError: false };
  },
}));

import { SEARCH_DEBOUNCE_MS, TrackPicker } from "@/components/social/music/track-picker";

const TT = [
  { id: "t1", title: "Espresso", artist: "Sabrina Carpenter", durationSec: 175, rank: 1, kind: "trending", previewUrl: "https://sf16.tiktokcdn.com/a.mp3", artworkUrl: "https://p16-sg.tiktokcdn.com/a.jpg" },
  { id: "t2", title: "Self Aware", artist: "Mark Allan Wolfe", durationSec: 227, rank: 2, kind: "trending", previewUrl: "https://sf16.tiktokcdn.com/b.mp3" },
];
const NOTE = "These are TikTok's current top 100 trending tracks — the only ones TikTok lets apps attach. There's no search. If your song isn't here, send the post as a TikTok draft and pick the sound in the TikTok app.";

beforeEach(() => {
  catalogData = { tracks: TT };
  catalogCalls.length = 0;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event("pause"));
  });
});
afterEach(() => {
  // Unmount every rendered tree BEFORE restoring the media mocks: an
  // still-mounted <audio> tears down through jsdom's real (unimplemented)
  // pause() otherwise, printing "Not implemented: HTMLMediaElement's pause()"
  // noise for every test.
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("TrackPicker — TikTok (trending, draft handoff)", () => {
  it("always shows TikTok's note and the draft button; no search box", () => {
    const onPick = vi.fn();
    render(<TrackPicker platform="tiktok" accountId="tt" value={null} onPick={onPick} />);
    expect(screen.getByTestId("track-picker-note")).toHaveTextContent(NOTE);
    expect(screen.queryByTestId("track-picker-search")).toBeNull();
    fireEvent.click(screen.getByTestId("track-picker-draft"));
    expect(screen.getByTestId("track-picker-draft")).toHaveTextContent("Send as a TikTok draft");
    expect(onPick).toHaveBeenCalledWith({ status: "draft" });
  });

  it("an empty value reads 'No track picked'; rows show rank, title, artist and duration", () => {
    render(<TrackPicker platform="tiktok" accountId="tt" value={null} onPick={vi.fn()} />);
    expect(screen.getByTestId("track-picker-selected")).toHaveTextContent("No track picked");
    expect(screen.getByTestId("track-row-t1")).toHaveTextContent("#1");
    expect(screen.getByTestId("track-row-t1")).toHaveTextContent("Espresso");
    expect(screen.getByTestId("track-row-t1")).toHaveTextContent("Sabrina Carpenter");
    expect(screen.getByTestId("track-row-t1")).toHaveTextContent("2:55");
  });

  it("Use picks the track; the picked row says Picked and the card shows it with its artwork through the proxy", () => {
    const onPick = vi.fn();
    const { rerender } = render(<TrackPicker platform="tiktok" accountId="tt" value={null} onPick={onPick} />);
    fireEvent.click(screen.getByTestId("track-use-t1"));
    expect(onPick).toHaveBeenCalledWith({ status: "picked", track: { id: "t1", title: "Espresso", artist: "Sabrina Carpenter", durationSec: 175 } });
    rerender(<TrackPicker platform="tiktok" accountId="tt" value={{ status: "picked", track: { id: "t1", title: "Espresso", artist: "Sabrina Carpenter" } }} onPick={onPick} />);
    expect(screen.getByTestId("track-use-t1")).toHaveTextContent("Picked");
    // Use and Picked share one fixed width: the row never shifts when a pick lands.
    expect(screen.getByTestId("track-use-t1").className).toContain("w-14");
    expect(screen.getByTestId("track-picker-selected")).toHaveTextContent("Espresso");
    // The list below is where a track is changed: the card has no Change button.
    expect(screen.queryByTestId("track-picker-change")).toBeNull();
    expect(screen.getByTestId("track-picker-selected").querySelector("img")?.getAttribute("src")).toBe(
      "/api/social/music/preview?kind=artwork&url=https%3A%2F%2Fp16-sg.tiktokcdn.com%2Fa.jpg",
    );
  });

  it("one preview at a time, through libi's proxy, with a volume slider; it stops on unmount", () => {
    const { container, unmount } = render(<TrackPicker platform="tiktok" accountId="tt" value={null} onPick={vi.fn()} />);
    fireEvent.click(screen.getByTestId("track-play-t1"));
    fireEvent.click(screen.getByTestId("track-play-t2"));
    const audios = container.querySelectorAll("audio");
    expect(audios).toHaveLength(1);
    expect(audios[0].getAttribute("src")).toBe("/api/social/music/preview?url=https%3A%2F%2Fsf16.tiktokcdn.com%2Fb.mp3");
    expect(screen.getByTestId("track-play-t1")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("track-play-t2")).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByTestId("track-picker-volume"), { target: { value: "50" } });
    expect(audios[0].volume).toBe(0.5);
    const pause = vi.mocked(HTMLMediaElement.prototype.pause);
    pause.mockClear();
    unmount();
    expect(pause).toHaveBeenCalled();
  });
});

describe("TrackPicker — nothing jumps when a preview starts", () => {
  it("the player bar is there, idle, before anything plays; the picked card grows no seek bar when it plays", () => {
    render(<TrackPicker platform="tiktok" accountId="tt" value={{ status: "picked", track: { id: "t1", title: "Espresso" } }} onPick={vi.fn()} />);
    const bar = screen.getByTestId("track-picker-player");
    expect(bar).toHaveTextContent("Press play on a track to preview it");
    expect(screen.getByRole("button", { name: "Play preview" })).toBeDisabled();
    expect(screen.getByTestId("track-picker-seek")).toBeDisabled();
    fireEvent.click(screen.getByTestId("track-play-t1"));
    expect(screen.getByTestId("track-picker-player")).toBe(bar);
    expect(screen.getByTestId("track-picker-seek")).not.toBeDisabled();
    expect(screen.getByTestId("track-picker-selected").querySelector('input[type="range"]')).toBeNull();
  });
});

describe("TrackPicker — Instagram (search)", () => {
  it("pre-fills the search with the song and asks the catalog after the debounce; no draft button, no note", () => {
    vi.useFakeTimers();
    catalogData = { tracks: [] };
    render(<TrackPicker platform="instagram" accountId="ig" value={null} onPick={vi.fn()} song={{ title: "Espresso", artist: "Sabrina Carpenter" }} />);
    expect(screen.getByTestId("track-picker-search")).toHaveValue("Espresso Sabrina Carpenter");
    expect(screen.queryByTestId("track-picker-draft")).toBeNull();
    expect(screen.queryByTestId("track-picker-note")).toBeNull();
    fireEvent.change(screen.getByTestId("track-picker-search"), { target: { value: "Taste" } });
    act(() => { vi.advanceTimersByTime(299); });
    expect(catalogCalls.at(-1)?.q).toBe("Espresso Sabrina Carpenter");
    act(() => { vi.advanceTimersByTime(1); });
    expect(catalogCalls.at(-1)?.q).toBe("Taste");
  });

  it("an unavailable catalog shows the reason line instead of a list", () => {
    catalogData = { unavailable: { reason: "needs_facebook_login" } };
    render(<TrackPicker platform="instagram" accountId="ig" value={null} onPick={vi.fn()} />);
    expect(screen.getByTestId("track-picker-unavailable")).toHaveTextContent("Instagram's music needs Facebook Login — reconnect the account.");
    expect(screen.queryByTestId("track-picker-list")).toBeNull();
  });

  it("keeps showing the title and lets pause work after a new search drops the playing track from the list", () => {
    vi.useFakeTimers();
    const A = { id: "a1", title: "Track A", artist: "Artist A", previewUrl: "https://scontent.cdninstagram.com/a.mp4", kind: "search" as const };
    const B = { id: "b1", title: "Track B", artist: "Artist B", previewUrl: "https://scontent.cdninstagram.com/b.mp4", kind: "search" as const };
    catalogData = { tracks: [A] };
    render(<TrackPicker platform="instagram" accountId="ig" value={null} onPick={vi.fn()} />);
    fireEvent.click(screen.getByTestId("track-play-a1"));
    expect(screen.getByTestId("track-picker-player")).toHaveTextContent("Track A");

    // A new search's results land without a1 — the played track disappears.
    catalogData = { tracks: [B] };
    fireEvent.change(screen.getByTestId("track-picker-search"), { target: { value: "new query" } });
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(screen.queryByTestId("track-row-a1")).toBeNull();

    // The bar still names the track that's actually playing, and pause still works.
    expect(screen.getByTestId("track-picker-player")).toHaveTextContent("Track A");
    const pause = vi.mocked(HTMLMediaElement.prototype.pause);
    fireEvent.click(screen.getByRole("button", { name: "Pause preview" }));
    expect(pause).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Play preview" })).toBeInTheDocument();
    expect(screen.getByTestId("track-picker-player")).toHaveTextContent("Track A");
  });
});
