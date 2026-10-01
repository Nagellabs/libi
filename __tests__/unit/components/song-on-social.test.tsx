// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { AudioRights } from "@/lib/audio-rights/types";

let connected = true;
const pickMutate = vi.fn();
const findMutate = vi.fn();
let findPending = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let findData: any = undefined;
let findVariables: string | undefined = "f1";
// Per-platform, so the "shared player" test can give tiktok and instagram
// each their own playable preview track.
const catalogByPlatform: Record<string, { tracks: Array<{ id: string; title: string; previewUrl?: string }> }> = {
  tiktok: { tracks: [] },
  instagram: { tracks: [] },
};
// Instagram defaults to "can't attach" (most tests check that copy); the
// shared-player test flips it so both rows can show a preview at once.
const factsByAccount: Record<string, unknown> = {
  tt: { tiktokKind: { value: "business", source: "detected", checkedAt: "t" } },
  ig: { instagramFacebookLogin: { value: false, source: "detected", checkedAt: "t" } },
};
vi.mock("@/lib/queries/social", () => ({
  useSocialStatus: () => ({ data: { connected } }),
  useSocialAccounts: () => ({ data: [
    { id: "tt", platform: "tiktok", active: true, username: "u", displayName: "U" },
    { id: "ig", platform: "instagram", active: true, username: "u", displayName: "U" },
  ], isLoading: false }),
}));
vi.mock("@/lib/queries/social-music", () => ({
  useSocialMusicFacts: () => ({ data: { facts: factsByAccount }, isLoading: false }),
  useMusicCatalog: (platform: string) => ({ data: catalogByPlatform[platform] ?? { tracks: [] }, isLoading: false, isError: false }),
}));
vi.mock("@/lib/queries/audio-rights", () => ({
  useSetPlatformPick: () => ({ mutate: pickMutate, error: null }),
  useFindSongAgain: () => ({ mutate: findMutate, isPending: findPending, error: null, data: findData, variables: findVariables }),
}));
let lastPicker: { platform: string; accountId: string; onPick: (c: unknown) => void } | null = null;
vi.mock("@/components/social/music/track-picker", () => ({
  TrackPicker: (p: { platform: string; accountId: string; onPick: (c: unknown) => void }) => {
    lastPicker = p;
    return <div data-testid="track-picker" />;
  },
}));

import { SongOnSocial } from "@/components/preview/song-on-social";

const SONG: AudioRights = { class: "copyrighted", track: { title: "Blinding Lights", artist: "The Weeknd" }, decidedBy: "agent", decidedAt: "x" };

beforeEach(() => {
  connected = true;
  findPending = false;
  findData = undefined;
  findVariables = "f1";
  catalogByPlatform.tiktok = { tracks: [] };
  catalogByPlatform.instagram = { tracks: [] };
  factsByAccount.tt = { tiktokKind: { value: "business", source: "detected", checkedAt: "t" } };
  factsByAccount.ig = { instagramFacebookLogin: { value: false, source: "detected", checkedAt: "t" } };
  pickMutate.mockReset();
  findMutate.mockReset();
  lastPicker = null;
});

describe("SongOnSocial", () => {
  it("shows nothing when social isn't connected, or the song isn't copyrighted", () => {
    connected = false;
    const { container, rerender } = render(<SongOnSocial fileId="f1" rights={SONG} />);
    expect(container).toBeEmptyDOMElement();
    connected = true;
    rerender(<SongOnSocial fileId="f1" rights={{ ...SONG, class: "owned" }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("one row per attach-capable platform, in the addendum's words", () => {
    render(<SongOnSocial fileId="f1" rights={{ ...SONG, platformPicks: { tiktok: { status: "picked", track: { id: "t1", title: "Blinding Lights", artist: "The Weeknd" }, decidedBy: "auto", decidedAt: "x" } } }} />);
    expect(screen.getByTestId("song-social-row-tiktok")).toHaveTextContent("TikTok · Blinding Lights — The Weeknd");
    expect(screen.getByTestId("song-social-action-tiktok")).toHaveTextContent("Change");
    expect(screen.getByTestId("song-social-row-instagram")).toHaveTextContent("Instagram · needs Facebook Login");
    expect(screen.queryByTestId("song-social-action-instagram")).toBeNull();
  });

  it("Choose opens the picker for that account; a pick saves at once and closes", () => {
    render(<SongOnSocial fileId="f1" rights={{ ...SONG, platformPicks: { tiktok: { status: "not_found", decidedBy: "auto", decidedAt: "x" } } }} />);
    expect(screen.getByTestId("song-social-row-tiktok")).toHaveTextContent("TikTok · not in the top 100 — will go as a draft");
    fireEvent.click(screen.getByTestId("song-social-action-tiktok"));
    expect(screen.getByTestId("track-picker")).toBeInTheDocument();
    expect(lastPicker).toMatchObject({ platform: "tiktok", accountId: "tt" });
    act(() => lastPicker!.onPick({ status: "picked", track: { id: "t9", title: "Other" } }));
    expect(pickMutate).toHaveBeenCalledWith({ fileId: "f1", platform: "tiktok", pick: { status: "picked", track: { id: "t9", title: "Other" }, accountId: "tt" } });
    expect(screen.queryByTestId("track-picker")).toBeNull();
  });

  it("Find again re-runs matching; while it runs it names the wait", () => {
    const { rerender } = render(<SongOnSocial fileId="f1" rights={SONG} />);
    fireEvent.click(screen.getByTestId("song-find-again"));
    expect(findMutate).toHaveBeenCalledWith("f1");
    findPending = true;
    rerender(<SongOnSocial fileId="f1" rights={SONG} />);
    expect(screen.getByTestId("song-find-again")).toHaveTextContent("Finding again…");
  });

  it("shows Find again's summary line, muted, when the result was skipped", () => {
    findData = { skipped: "not_copyrighted", summary: ["This audio isn't copyrighted — nothing to match."] };
    render(<SongOnSocial fileId="f1" rights={SONG} />);
    expect(screen.getByTestId("song-find-again-summary")).toHaveTextContent("This audio isn't copyrighted — nothing to match.");
  });

  it("shows Find again's summary line when nothing matched on any platform", () => {
    findData = { platforms: {}, summary: ["No connected account is on a platform that attaches licensed music."] };
    render(<SongOnSocial fileId="f1" rights={SONG} />);
    expect(screen.getByTestId("song-find-again-summary")).toHaveTextContent("No connected account is on a platform that attaches licensed music.");
  });

  it("does not show a summary line when Find again actually matched something", () => {
    findData = { platforms: { tiktok: { status: "picked", accountId: "tt", track: { id: "t9", title: "Other" } } }, summary: ["Matched on TikTok: *Other*."] };
    render(<SongOnSocial fileId="f1" rights={SONG} />);
    expect(screen.queryByTestId("song-find-again-summary")).toBeNull();
  });

  it("a Find again result never carries over to another file (M5)", () => {
    findData = { platforms: {}, summary: ["No connected account is on a platform that attaches licensed music."] };
    const { rerender } = render(<SongOnSocial fileId="f1" rights={SONG} />);
    expect(screen.getByTestId("song-find-again-summary")).toBeInTheDocument();
    rerender(<SongOnSocial fileId="f2" rights={SONG} />);
    expect(screen.queryByTestId("song-find-again-summary")).toBeNull();
  });

  it("shows the platforms Find again couldn't finish, even when another matched (M5)", () => {
    findData = {
      platforms: {
        tiktok: { status: "picked", accountId: "tt", track: { id: "t9", title: "Other" } },
        instagram: { status: "error", accountId: "ig", reason: "timeout" },
      },
      incomplete: "timeout",
      summary: ["Matched on TikTok: *Other*."],
    };
    render(<SongOnSocial fileId="f1" rights={SONG} />);
    const summary = screen.getByTestId("song-find-again-summary");
    expect(summary).toHaveTextContent("Instagram didn't answer in time — try Find again.");
    expect(summary).not.toHaveTextContent("Matched on TikTok");
    findData = { platforms: { tiktok: { status: "error", accountId: "tt", reason: "song_changed" }, instagram: { status: "error", reason: "provider_error" } }, summary: [] };
    render(<SongOnSocial fileId="f1" rights={SONG} />);
    expect(screen.getByText("The song changed while TikTok was looking — try Find again.")).toBeInTheDocument();
    expect(screen.getByText("Instagram's music library couldn't be read — try Find again.")).toBeInTheDocument();
  });

  it("shares ONE preview player across rows, so a second row's play stops the first", () => {
    factsByAccount.ig = { instagramFacebookLogin: { value: true, source: "detected", checkedAt: "t" } };
    catalogByPlatform.tiktok = { tracks: [{ id: "tt-track", title: "TT Song", previewUrl: "https://p.tiktokcdn.com/tt.mp3" }] };
    catalogByPlatform.instagram = { tracks: [{ id: "ig-track", title: "IG Song", previewUrl: "https://p.cdninstagram.com/ig.mp3" }] };
    render(
      <SongOnSocial
        fileId="f1"
        rights={{
          ...SONG,
          platformPicks: {
            tiktok: { status: "picked", track: { id: "tt-track", title: "TT Song" }, decidedBy: "auto", decidedAt: "x" },
            instagram: { status: "picked", track: { id: "ig-track", title: "IG Song" }, decidedBy: "auto", decidedAt: "x" },
          },
        }}
      />,
    );
    // Exactly one shared <audio> element for the whole block, not one per row.
    expect(document.querySelectorAll("audio").length).toBe(1);
    const audioEl = document.querySelector("audio") as HTMLAudioElement;
    fireEvent.click(screen.getByTestId("song-social-play-tiktok"));
    expect(audioEl.src).toContain(encodeURIComponent("https://p.tiktokcdn.com/tt.mp3"));
    fireEvent.click(screen.getByTestId("song-social-play-instagram"));
    // The SAME shared element now plays the second row's track — the first
    // one is no longer the one loaded, so it can't still be playing.
    expect(audioEl.src).toContain(encodeURIComponent("https://p.cdninstagram.com/ig.mp3"));
  });
});
