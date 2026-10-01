// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let planData: unknown;
let planError = false;
const planCalls: unknown[] = [];
const planRefetch = vi.fn();
const fetchPlan = vi.fn(async () => undefined);
vi.mock("@/lib/queries/social-music", () => ({
  useMusicPlan: (_pieceId: string, target: unknown) => {
    planCalls.push(target);
    return { data: planError ? undefined : planData, isLoading: !planError && planData === undefined, isError: planError, refetch: planRefetch };
  },
  useFetchMusicPlan: () => fetchPlan,
}));

const pickMutate = vi.fn(async () => undefined);
vi.mock("@/lib/queries/audio-rights", () => ({ useSetPlatformPick: () => ({ mutateAsync: pickMutate, error: null }) }));

let lastPicker: { value: unknown; onPick: (c: unknown) => void; song?: unknown } | null = null;
vi.mock("@/components/social/music/track-picker", () => ({
  TrackPicker: (p: { value: unknown; onPick: (c: unknown) => void; song?: unknown }) => {
    lastPicker = p;
    return <div data-testid="track-picker" />;
  },
}));

import { MusicBlock } from "@/components/social/music/music-block";

const attachPlan = {
  copyrighted: true, hasMusic: true, variants: {},
  targets: [{
    platform: "instagram", accountId: "ig",
    plan: { mode: "attach", track: { id: "ig-1", title: "Espresso", artist: "Sabrina Carpenter" }, volumes: { music: 80, original: 100 }, exportVariant: "without-song",
      sentence: "Posts without *Espresso — Sabrina Carpenter* and attaches Instagram's licensed version.", warnings: [], allowedModes: ["attach", "include", "strip"] },
    music: { mode: "attach", track: { id: "ig-1", title: "Espresso", artist: "Sabrina Carpenter" }, musicVolume: 80, originalVolume: 100 },
  }],
};

beforeEach(() => {
  planCalls.length = 0;
  planError = false;
  planData = attachPlan;
  pickMutate.mockReset();
  pickMutate.mockImplementation(async () => undefined);
  fetchPlan.mockClear();
  planRefetch.mockReset();
  lastPicker = null;
});

describe("MusicBlock", () => {
  it("a plan that could not be worked out says so, with a Try again that refetches", () => {
    planError = true;
    const onChange = vi.fn();
    render(<MusicBlock pieceId="p" platform="instagram" accountId="ig" onChange={onChange} />);
    expect(screen.getByTestId("music-plan-error")).toHaveTextContent("Couldn't work out the music plan — try again.");
    expect(screen.queryByTestId("music-block-skeleton")).toBeNull();
    fireEvent.click(screen.getByTestId("music-plan-retry"));
    expect(planRefetch).toHaveBeenCalledTimes(1);
  });

  it("reports the error, and clears it once the plan comes back", () => {
    planError = true;
    const onError = vi.fn();
    const { rerender } = render(<MusicBlock pieceId="p" platform="instagram" accountId="ig" onChange={vi.fn()} onError={onError} />);
    expect(onError).toHaveBeenLastCalledWith(true);
    planError = false;
    rerender(<MusicBlock pieceId="p" platform="instagram" accountId="ig" onChange={vi.fn()} onError={onError} />);
    expect(onError).toHaveBeenLastCalledWith(false);
  });

  it("shows the plan sentence with the song in italics and reports the plan's music", () => {
    const onChange = vi.fn();
    render(<MusicBlock pieceId="p" platform="instagram" accountId="ig" onChange={onChange} />);
    const s = screen.getByTestId("music-sentence");
    expect(s).toHaveTextContent("Posts without Espresso — Sabrina Carpenter and attaches Instagram's licensed version.");
    expect(s.querySelector("em")).toHaveTextContent("Espresso — Sabrina Carpenter");
    expect(onChange).toHaveBeenCalledWith(attachPlan.targets[0].music);
  });

  it("offers only the modes the platform allows, and a change re-plans", () => {
    render(<MusicBlock pieceId="p" platform="instagram" accountId="ig" onChange={vi.fn()} />);
    const select = screen.getByTestId("music-mode") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["attach", "include", "strip"]);
    fireEvent.change(select, { target: { value: "include" } });
    expect(planCalls.at(-1)).toMatchObject({ platform: "instagram", accountId: "ig", music: { mode: "include" } });
  });

  it("volume sliders change the reported music without re-planning", () => {
    const onChange = vi.fn();
    render(<MusicBlock pieceId="p" platform="instagram" accountId="ig" onChange={onChange} />);
    const before = planCalls.length;
    fireEvent.change(screen.getByTestId("music-volume"), { target: { value: "40" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ musicVolume: 40, originalVolume: 100 }));
    expect(planCalls.slice(before).every((t) => JSON.stringify(t) === JSON.stringify(planCalls[0]))).toBe(true); // same target: no re-plan
    expect(planCalls.at(-1)).toEqual(planCalls[0]);
  });

  it("shows the requirement banner and the warnings", () => {
    planData = { ...attachPlan, targets: [{ ...attachPlan.targets[0], plan: { ...attachPlan.targets[0].plan, mode: "strip", needs: "Reconnect Instagram with Facebook Login to attach licensed music.", warnings: ["w1"], allowedModes: ["include", "strip"] }, music: { mode: "strip" } }] };
    render(<MusicBlock pieceId="p" platform="instagram" accountId="ig" onChange={vi.fn()} />);
    expect(screen.getByTestId("music-needs")).toHaveTextContent("Reconnect Instagram with Facebook Login to attach licensed music.");
    expect(screen.getByTestId("music-warning")).toHaveTextContent("w1");
    expect(screen.queryByTestId("track-picker")).toBeNull();
  });

  it("a skeleton while the plan loads", () => {
    planData = undefined;
    render(<MusicBlock pieceId="p" platform="instagram" accountId="ig" onChange={vi.fn()} />);
    expect(screen.getByTestId("music-block-skeleton")).toBeInTheDocument();
  });

  it("a piece with no music shows only the plan's sentence, no picker", () => {
    planData = { copyrighted: false, hasMusic: false, variants: {}, targets: [{ platform: "instagram", accountId: "ig", plan: { mode: "include", sentence: "This piece has no music to handle.", warnings: [], exportVariant: "without-song", allowedModes: ["include"] }, music: { mode: "include" } }] };
    render(<MusicBlock pieceId="p" platform="instagram" accountId="ig" onChange={vi.fn()} />);
    expect(screen.getByTestId("music-sentence")).toHaveTextContent("This piece has no music to handle.");
    expect(screen.queryByTestId("track-picker")).toBeNull();
  });

  it("the user's saved choice for this post is the plan's override", () => {
    render(<MusicBlock pieceId="p" platform="instagram" accountId="ig" choice={{ mode: "include" }} value={{ mode: "include" }} onChange={vi.fn()} />);
    expect(planCalls[0]).toMatchObject({ platform: "instagram", accountId: "ig", music: { mode: "include" } });
  });

  it("a reported (resolved) music is NEVER the override — coming back re-plans from the song's current pick (I1)", () => {
    // The plan's earlier answer was an AUTOMATIC match; the details panel has
    // since picked another track. Remounting (step change, restored draft)
    // must ask for the plan with no override, so the song's pick wins.
    const auto = { mode: "attach" as const, track: { id: "tt-auto", title: "Espresso", artist: "Sabrina Carpenter" }, musicVolume: 80, originalVolume: 100 };
    render(<MusicBlock pieceId="p" platform="tiktok" accountId="tt" value={auto} onChange={vi.fn()} />);
    expect(planCalls[0]).toEqual({ platform: "tiktok", accountId: "tt" });
  });

  it("restoring a saved attach keeps its volumes, not the plan's defaults — but not its track as an override", () => {
    const onChange = vi.fn();
    const value = { mode: "attach" as const, track: { id: "ig-1", title: "Espresso", artist: "Sabrina Carpenter" }, musicVolume: 30, originalVolume: 70 };
    render(<MusicBlock pieceId="p" platform="instagram" accountId="ig" value={value} onChange={onChange} />);
    expect(planCalls[0]).toEqual({ platform: "instagram", accountId: "ig" });
    expect((screen.getByTestId("music-volume") as HTMLInputElement).value).toBe("30");
    expect((screen.getByTestId("original-volume") as HTMLInputElement).value).toBe("70");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "attach", musicVolume: 30, originalVolume: 70 }));
  });

  it("shows the picker whenever the platform can attach; its value is the plan's track", () => {
    render(<MusicBlock pieceId="p" platform="instagram" accountId="ig" onChange={vi.fn()} mainSong={{ fileId: "s", track: { title: "Espresso", artist: "Sabrina Carpenter" } }} />);
    expect(screen.getByTestId("track-picker")).toBeInTheDocument();
    expect(lastPicker?.value).toEqual({ status: "picked", track: { id: "ig-1", title: "Espresso", artist: "Sabrina Carpenter" } });
    expect(lastPicker?.song).toEqual({ title: "Espresso", artist: "Sabrina Carpenter" });
  });

  it("a pick becomes the song's own pick; it rides as the post's override only until the write lands", async () => {
    let settle!: () => void;
    pickMutate.mockImplementation(() => new Promise<undefined>((r) => (settle = () => r(undefined))));
    const onChoice = vi.fn();
    const { rerender } = render(<MusicBlock pieceId="p" platform="instagram" accountId="ig" onChange={vi.fn()} onChoice={onChoice} mainSong={{ fileId: "s" }} />);
    act(() => lastPicker!.onPick({ status: "picked", track: { id: "ig-2", title: "Espresso (Live)" } }));
    expect(planCalls.at(-1)).toEqual({ platform: "instagram", accountId: "ig", music: { mode: "attach", trackId: "ig-2" } });
    expect(onChoice).toHaveBeenLastCalledWith({ mode: "attach", trackId: "ig-2" });
    expect(pickMutate).toHaveBeenCalledWith({ fileId: "s", platform: "instagram", pick: { status: "picked", track: { id: "ig-2", title: "Espresso (Live)" }, accountId: "ig" } });
    expect(pickMutate).toHaveBeenCalledTimes(1);
    // A re-render (e.g. the plan refetching in the background) must not
    // re-fire the write — `pick` runs from the click handler, never an effect.
    rerender(<MusicBlock pieceId="p" platform="instagram" accountId="ig" onChange={vi.fn()} onChoice={onChoice} mainSong={{ fileId: "s" }} />);
    expect(pickMutate).toHaveBeenCalledTimes(1);
    // The write lands: the override-free plan is fetched fresh, then the override is dropped.
    await act(async () => settle());
    await waitFor(() => expect(planCalls.at(-1)).toEqual({ platform: "instagram", accountId: "ig" }));
    expect(fetchPlan).toHaveBeenCalledWith("p", { platform: "instagram", accountId: "ig" });
    expect(onChoice).toHaveBeenLastCalledWith(undefined, { mode: "attach", trackId: "ig-2" });
  });

  it("a failed write keeps the pick as this post's own choice", async () => {
    pickMutate.mockImplementation(async () => {
      throw new Error("nope");
    });
    const onChoice = vi.fn();
    render(<MusicBlock pieceId="p" platform="instagram" accountId="ig" onChange={vi.fn()} onChoice={onChoice} mainSong={{ fileId: "s" }} />);
    await act(async () => lastPicker!.onPick({ status: "picked", track: { id: "ig-2", title: "Espresso (Live)" } }));
    expect(planCalls.at(-1)).toEqual({ platform: "instagram", accountId: "ig", music: { mode: "attach", trackId: "ig-2" } });
    expect(onChoice).toHaveBeenCalledTimes(1);
  });

  it("'Send as a draft' re-plans as a draft and writes the draft pick; a draft plan hides the picker and leaves the finish link to the sent post", () => {
    const ttAttach = { ...attachPlan, targets: [{ ...attachPlan.targets[0], platform: "tiktok", plan: { ...attachPlan.targets[0].plan, allowedModes: ["attach", "draft", "include", "strip"] } }] };
    planData = ttAttach;
    // FinishLink (real, unmocked) draws its QR via `useQuery`.
    const { rerender } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MusicBlock pieceId="p" platform="tiktok" accountId="tt" onChange={vi.fn()} mainSong={{ fileId: "s" }} />
      </QueryClientProvider>,
    );
    act(() => {
      lastPicker!.onPick({ status: "draft" });
    });
    expect(planCalls).toContainEqual({ platform: "tiktok", accountId: "tt", music: { mode: "draft" } });
    expect(pickMutate).toHaveBeenCalledWith({ fileId: "s", platform: "tiktok", pick: { status: "draft", accountId: "tt" } });
    expect(pickMutate).toHaveBeenCalledTimes(1);
    // The user's choice shows at once, before its plan answers: the list is for attaching only.
    expect((screen.getByTestId("music-mode") as HTMLSelectElement).value).toBe("draft");
    expect(screen.queryByTestId("track-picker")).toBeNull();
    planData = { ...ttAttach, targets: [{ ...ttAttach.targets[0], plan: { ...ttAttach.targets[0].plan, mode: "draft", track: undefined }, music: { mode: "draft" } }] };
    // Same guard: a re-render (the plan the pick itself triggered, coming back) writes nothing more.
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MusicBlock pieceId="p" platform="tiktok" accountId="tt" onChange={vi.fn()} mainSong={{ fileId: "s" }} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("music-finish-after-post")).toHaveTextContent("Once it's posted, the post shows how to open the draft in TikTok.");
    // No link or QR before posting: TikTok gives a draft no URL, and the post's own card carries the finish link.
    expect(screen.queryByTestId("finish-link-tiktok-inbox")).toBeNull();
    expect(screen.queryByTestId("tiktok-qr")).toBeNull();
    expect(screen.queryByTestId("track-picker")).toBeNull();
    expect(pickMutate).toHaveBeenCalledTimes(1);
  });

  it("Use shows the track as picked at once and keeps the card (and its picker) on screen while the new plan loads", async () => {
    let settle!: () => void;
    pickMutate.mockImplementation(() => new Promise<undefined>((r) => (settle = () => r(undefined))));
    render(<MusicBlock pieceId="p" platform="instagram" accountId="ig" onChange={vi.fn()} mainSong={{ fileId: "s" }} />);
    act(() => lastPicker!.onPick({ status: "picked", track: { id: "ig-2", title: "Espresso (Live)" } }));
    // The plan for the pick hasn't answered (the mock still serves the old one): the picker shows the pick anyway.
    expect(lastPicker!.value).toEqual({ status: "picked", track: { id: "ig-2", title: "Espresso (Live)" } });
    expect(screen.queryByTestId("music-block-skeleton")).toBeNull();
    expect(screen.getByTestId("track-picker")).toBeInTheDocument();
    await act(async () => settle());
  });

  it("the volumes sit in their own card under the track selection", () => {
    render(<MusicBlock pieceId="p" platform="instagram" accountId="ig" onChange={vi.fn()} mainSong={{ fileId: "s" }} />);
    const card = screen.getByTestId("music-volumes");
    expect(card).toHaveTextContent("Volume");
    expect(card).toContainElement(screen.getByTestId("music-volume"));
    expect(card).toContainElement(screen.getByTestId("original-volume"));
    expect(screen.getByTestId("track-picker").compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the list is shown for attaching only — Keep in / Leave out hide it", () => {
    render(<MusicBlock pieceId="p" platform="instagram" accountId="ig" onChange={vi.fn()} mainSong={{ fileId: "s" }} />);
    expect(screen.getByTestId("track-picker")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("music-mode"), { target: { value: "strip" } });
    expect(screen.queryByTestId("track-picker")).toBeNull();
  });

  describe("no matching track (awaitingPick)", () => {
    const awaiting = {
      ...attachPlan,
      targets: [{
        ...attachPlan.targets[0], platform: "tiktok", accountId: "tt",
        plan: { mode: "draft", exportVariant: "without-song", sentence: "Sends a TikTok draft without the song.", warnings: ["No exact match for *Espresso* in TikTok's trending list — pick a track to attach it instead."], allowedModes: ["attach", "draft", "include", "strip"], awaitingPick: true },
        music: { mode: "draft" },
      }],
    };
    const wrap = (ui: React.ReactElement) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

    it("shows attach with nothing picked, reports no music (Next holds) and says to pick or choose another option", () => {
      planData = awaiting;
      const onChange = vi.fn();
      const onAwaitingPick = vi.fn();
      const onResolved = vi.fn();
      render(wrap(<MusicBlock pieceId="p" platform="tiktok" accountId="tt" onChange={onChange} onAwaitingPick={onAwaitingPick} onResolved={onResolved} mainSong={{ fileId: "s" }} />));
      expect((screen.getByTestId("music-mode") as HTMLSelectElement).value).toBe("attach");
      expect(lastPicker!.value).toBeNull();
      expect(screen.getByTestId("music-awaiting-pick")).toHaveTextContent("Pick a track below to attach it — or choose another option above.");
      expect(screen.queryByTestId("music-finish-after-post")).toBeNull();
      expect(onChange).toHaveBeenLastCalledWith(undefined);
      expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ mode: "draft" }));
      expect(onAwaitingPick).toHaveBeenLastCalledWith(true);
      expect(onResolved).toHaveBeenLastCalledWith(false);
    });

    it("choosing another option is this post's choice and hides the list — the song's (not_found) pick is not touched", () => {
      planData = awaiting;
      const onChoice = vi.fn();
      render(wrap(<MusicBlock pieceId="p" platform="tiktok" accountId="tt" onChange={vi.fn()} onChoice={onChoice} mainSong={{ fileId: "s" }} />));
      fireEvent.change(screen.getByTestId("music-mode"), { target: { value: "include" } });
      expect(onChoice).toHaveBeenLastCalledWith({ mode: "include" });
      expect(pickMutate).not.toHaveBeenCalled();
      expect(screen.queryByTestId("track-picker")).toBeNull();
    });
  });

  it("reports whether the plan is resolved", () => {
    const onResolved = vi.fn();
    render(<MusicBlock pieceId="p" platform="instagram" accountId="ig" onChange={vi.fn()} onResolved={onResolved} />);
    expect(onResolved).toHaveBeenLastCalledWith(true);
  });

  it("reports unresolved for a plan that still needs a choice", () => {
    planData = { ...attachPlan, targets: [{ ...attachPlan.targets[0], plan: { ...attachPlan.targets[0].plan, needsChoice: true } }] };
    const onResolved = vi.fn();
    render(<MusicBlock pieceId="p" platform="instagram" accountId="ig" onChange={vi.fn()} onResolved={onResolved} />);
    expect(onResolved).toHaveBeenLastCalledWith(false);
  });

  it("no picker where the account can't attach", () => {
    planData = { ...attachPlan, targets: [{ ...attachPlan.targets[0], plan: { ...attachPlan.targets[0].plan, mode: "strip", track: undefined, allowedModes: ["include", "strip"] }, music: { mode: "strip" } }] };
    render(<MusicBlock pieceId="p" platform="instagram" accountId="ig" onChange={vi.fn()} />);
    expect(screen.queryByTestId("track-picker")).toBeNull();
  });

  it("while the piece's audio rights are still loading, no picker is shown to click (never a silently dropped pick)", () => {
    render(<MusicBlock pieceId="p" platform="instagram" accountId="ig" onChange={vi.fn()} mainSongLoading />);
    expect(screen.getByTestId("music-track-picker-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("track-picker")).toBeNull();
  });

  it("if the piece's audio rights query itself errored, the picker is disabled with a short line, not a silent drop", () => {
    render(<MusicBlock pieceId="p" platform="instagram" accountId="ig" onChange={vi.fn()} mainSongError />);
    expect(screen.getByTestId("music-track-picker-error")).toBeInTheDocument();
    expect(screen.queryByTestId("track-picker")).toBeNull();
    expect(screen.queryByTestId("music-track-picker-loading")).toBeNull();
  });

  describe("the mode menu writes the song's pick like the picker does (M9)", () => {
    const ttAttach = {
      ...attachPlan,
      targets: [{
        ...attachPlan.targets[0], platform: "tiktok", accountId: "tt",
        plan: { ...attachPlan.targets[0].plan, track: { id: "tt-1", title: "Espresso", artist: "Sabrina Carpenter" }, allowedModes: ["attach", "draft", "include", "strip"] },
        music: { mode: "attach", track: { id: "tt-1", title: "Espresso", artist: "Sabrina Carpenter" }, musicVolume: 80, originalVolume: 100 },
      }],
    };
    const ttDraft = { ...ttAttach, targets: [{ ...ttAttach.targets[0], plan: { ...ttAttach.targets[0].plan, mode: "draft", track: undefined }, music: { mode: "draft" } }] };
    const wrap = (ui: React.ReactElement) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

    it("Draft writes {status: draft} — one write", async () => {
      planData = ttAttach;
      render(wrap(<MusicBlock pieceId="p" platform="tiktok" accountId="tt" onChange={vi.fn()} mainSong={{ fileId: "s" }} />));
      await act(async () => {
        fireEvent.change(screen.getByTestId("music-mode"), { target: { value: "draft" } });
      });
      expect(pickMutate).toHaveBeenCalledTimes(1);
      expect(pickMutate).toHaveBeenCalledWith({ fileId: "s", platform: "tiktok", pick: { status: "draft", accountId: "tt" } });
    });

    it("back to Attach clears the draft pick — never re-writes the shown (maybe automatic) track as the user's — one write", async () => {
      planData = ttAttach;
      const { rerender } = render(wrap(<MusicBlock pieceId="p" platform="tiktok" accountId="tt" onChange={vi.fn()} mainSong={{ fileId: "s" }} />));
      await act(async () => {
        fireEvent.change(screen.getByTestId("music-mode"), { target: { value: "draft" } });
      });
      planData = ttDraft;
      rerender(wrap(<MusicBlock pieceId="p" platform="tiktok" accountId="tt" onChange={vi.fn()} mainSong={{ fileId: "s" }} />));
      pickMutate.mockClear();
      let settle!: () => void;
      pickMutate.mockImplementation(() => new Promise<undefined>((r) => (settle = () => r(undefined))));
      act(() => {
        fireEvent.change(screen.getByTestId("music-mode"), { target: { value: "attach" } });
      });
      expect(pickMutate).toHaveBeenCalledTimes(1);
      expect(pickMutate).toHaveBeenCalledWith({ fileId: "s", platform: "tiktok", pick: null });
      // Until the clear lands, this post asks for attach; then the song's own match decides.
      expect(planCalls.at(-1)).toEqual({ platform: "tiktok", accountId: "tt", music: { mode: "attach" } });
      await act(async () => settle());
      await waitFor(() => expect(planCalls.at(-1)).toEqual({ platform: "tiktok", accountId: "tt" }));
    });

    it("Attach with no song to write to asks this post's plan for attach and writes nothing", () => {
      planData = ttDraft;
      const onChoice = vi.fn();
      render(wrap(<MusicBlock pieceId="p" platform="tiktok" accountId="tt" onChange={vi.fn()} onChoice={onChoice} />));
      fireEvent.change(screen.getByTestId("music-mode"), { target: { value: "attach" } });
      expect(pickMutate).not.toHaveBeenCalled();
      expect(onChoice).toHaveBeenLastCalledWith({ mode: "attach" });
    });

    it("a user-picked track → Keep in → Attach: no write; this post asks for attach and the stored track decides which", () => {
      // The song's pick is the user's track; this post keeps the song in.
      const ttInclude = { ...ttAttach, targets: [{ ...ttAttach.targets[0], plan: { ...ttAttach.targets[0].plan, mode: "include", track: undefined }, music: { mode: "include" } }] };
      planData = ttInclude;
      const onChoice = vi.fn();
      const { rerender } = render(wrap(<MusicBlock pieceId="p" platform="tiktok" accountId="tt" choice={{ mode: "include" }} onChange={vi.fn()} onChoice={onChoice} mainSong={{ fileId: "s" }} />));
      expect(planCalls.at(-1)).toEqual({ platform: "tiktok", accountId: "tt", music: { mode: "include" } });
      fireEvent.change(screen.getByTestId("music-mode"), { target: { value: "attach" } });
      expect(pickMutate).not.toHaveBeenCalled();
      expect(onChoice).toHaveBeenLastCalledWith({ mode: "attach" });
      // Attach names no track: the song's stored (user) track is what attaches.
      expect(planCalls.at(-1)).toEqual({ platform: "tiktok", accountId: "tt", music: { mode: "attach" } });
      planData = ttAttach;
      rerender(wrap(<MusicBlock pieceId="p" platform="tiktok" accountId="tt" choice={{ mode: "include" }} onChange={vi.fn()} onChoice={onChoice} mainSong={{ fileId: "s" }} />));
      expect((screen.getByTestId("music-mode") as HTMLSelectElement).value).toBe("attach");
      expect(pickMutate).not.toHaveBeenCalled();
    });

    it("Keep in → Attach on a song whose TikTok pick is a draft stays Attach — the draft pick never overrules the menu", () => {
      const ttInclude = { ...ttAttach, targets: [{ ...ttAttach.targets[0], plan: { ...ttAttach.targets[0].plan, mode: "include", track: undefined }, music: { mode: "include" } }] };
      planData = ttInclude;
      render(wrap(<MusicBlock pieceId="p" platform="tiktok" accountId="tt" choice={{ mode: "include" }} onChange={vi.fn()} mainSong={{ fileId: "s" }} />));
      // The plan for the new override hasn't answered (the mock still serves Keep in).
      fireEvent.change(screen.getByTestId("music-mode"), { target: { value: "attach" } });
      expect((screen.getByTestId("music-mode") as HTMLSelectElement).value).toBe("attach");
      expect(planCalls.at(-1)).toEqual({ platform: "tiktok", accountId: "tt", music: { mode: "attach" } });
    });

    it("Keep it in is this post's alone: no write", () => {
      planData = ttAttach;
      const onChoice = vi.fn();
      render(wrap(<MusicBlock pieceId="p" platform="tiktok" accountId="tt" onChange={vi.fn()} onChoice={onChoice} mainSong={{ fileId: "s" }} />));
      fireEvent.change(screen.getByTestId("music-mode"), { target: { value: "include" } });
      expect(pickMutate).not.toHaveBeenCalled();
      expect(onChoice).toHaveBeenLastCalledWith({ mode: "include" });
    });
  });
});
