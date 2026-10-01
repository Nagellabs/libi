// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let trackAnswer: { track: unknown } | undefined = { track: { id: "ig-1" } };
vi.mock("@/lib/queries/social-music", () => ({ useCatalogTrack: () => ({ data: trackAnswer }) }));

import { PostMusicSummary, hasPostMusic } from "@/components/social/music/post-music-summary";
import type { SocialPost } from "@/lib/social/types";

const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
const post = (over: Partial<SocialPost>): SocialPost => ({
  id: "p", status: "published", content: "", createdAt: "x", media: [], tags: [],
  targets: [{ platform: "tiktok", accountId: "tt", status: "published" }, { platform: "instagram", accountId: "ig", status: "published" }],
  libi: { pieceId: "piece", targetOptions: [
    { platform: "tiktok", tiktok: {} as never, music: { mode: "draft" } },
    { platform: "instagram", instagram: { contentType: "reel" }, music: { mode: "attach", track: { id: "ig-1", title: "Espresso", artist: "Sabrina Carpenter" }, musicVolume: 80, originalVolume: 100 } },
  ] },
  ...over,
});

describe("PostMusicSummary", () => {
  it("one line per target, and TikTok's finish link with a QR code", async () => {
    wrap(<PostMusicSummary post={post({})} pieceHasCopyrighted />);
    expect(screen.getByTestId("post-music-tiktok-tt")).toHaveTextContent("Draft to finish in the app");
    expect(screen.getByTestId("post-music-instagram-ig")).toHaveTextContent("Licensed track attached — Espresso — Sabrina Carpenter");
    expect(screen.getByTestId("finish-link-tiktok-inbox")).toHaveAttribute("href", "https://www.tiktok.com/");
    expect(screen.getByTestId("finish-link-tiktok-inbox")).toHaveTextContent("Open TikTok to finish");
    expect(screen.getByText("On your phone, open TikTok and tap the inbox notification for this draft.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("tiktok-qr").getAttribute("src")).toMatch(/^data:image\/svg\+xml/));
    expect(screen.queryByTestId("music-track-gone")).toBeNull();
  });

  it("warns when a scheduled Instagram post's track is gone", () => {
    trackAnswer = { track: null };
    wrap(<PostMusicSummary post={post({ status: "scheduled" })} pieceHasCopyrighted />);
    expect(screen.getByTestId("music-track-gone")).toHaveTextContent("Instagram no longer offers Espresso. Edit the post to pick another track, or it posts without it.");
    trackAnswer = { track: { id: "ig-1" } };
  });

  it("a published YouTube post of a piece with a copyrighted song links to Studio's editor, even with no music stamp", () => {
    const yt = post({ targets: [{ platform: "youtube", accountId: "yt", status: "published", platformPostId: "vid1" }], libi: { pieceId: "piece" } });
    expect(hasPostMusic(yt, true)).toBe(true);
    wrap(<PostMusicSummary post={yt} pieceHasCopyrighted />);
    expect(screen.getByTestId("post-music-youtube-yt")).toHaveTextContent("Song kept in the video");
    expect(screen.getByTestId("finish-link-youtube-studio-editor")).toHaveAttribute("href", "https://studio.youtube.com/video/vid1/editor");
  });

  it("renders nothing for a draft with no music (so the post row draws no empty divider)", () => {
    const d = post({ status: "draft", targets: [{ platform: "instagram", accountId: "ig", status: "pending" }], libi: { pieceId: "piece" } });
    expect(hasPostMusic(d, true)).toBe(false);
    const { container } = wrap(<PostMusicSummary post={d} pieceHasCopyrighted />);
    expect(container).toBeEmptyDOMElement();
  });
});
