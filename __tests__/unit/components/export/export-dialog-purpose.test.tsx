// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/lib/queries/export-defaults", () => ({ useExportDefaults: () => ({ data: undefined }) }));
vi.mock("@/lib/shell/client", () => ({ revealFile: vi.fn(), pickDirectory: vi.fn(async () => undefined), hasElectronBridge: () => false }));
vi.mock("@/lib/queries/social", () => ({ useSocialStatus: () => ({ data: undefined }) }));

import { ExportDialog } from "@/components/export/export-dialog";
import type { UseExportFlowResult } from "@/hooks/editor/use-export-flow";
import type { ExportAudioTrack } from "@/components/export/audio-defaults";

function flow() {
  return { status: "idle", progress: null, result: null, error: null, start: vi.fn(), cancel: vi.fn(), reset: vi.fn() } as unknown as UseExportFlowResult & { start: ReturnType<typeof vi.fn> };
}
const TRACKS: ExportAudioTrack[] = [
  { fileId: "song", label: "Espresso — Sabrina Carpenter", fileType: "audio", rights: "copyrighted", platformsLine: "TikTok attaches it at posting · Instagram: left out" },
  { fileId: "clip", label: "clip.mp4", fileType: "video", rights: "owned" },
  { fileId: "bed", label: "Bed", fileType: "audio", rights: "generated" },
];
function renderIt(opts: { tracks?: ExportAudioTrack[]; initialPurpose?: "social" | "personal" } = {}) {
  const f = flow();
  render(<ExportDialog pieceId="p1" pieceName="My piece" compositionWidth={1080} compositionHeight={1920} flow={f} hasSnapshot hasDraft openOverride audioTracks={opts.tracks ?? TRACKS} initialPurpose={opts.initialPurpose} />);
  return f;
}
const exportButton = () => screen.getAllByRole("button", { name: "Export" }).at(-1)!;

describe("ExportDialog — two columns, Social by default", () => {
  it("lays Video and Audio side by side and preselects Social / ad post; Export is enabled", () => {
    renderIt();
    expect(screen.getByTestId("export-video-column")).toHaveTextContent("Video");
    expect(screen.getByTestId("export-audio-column")).toHaveTextContent("Audio");
    expect(screen.getByText("What's this export for?")).toBeInTheDocument();
    expect(screen.getByTestId("export-purpose-social")).toHaveTextContent("Social / ad post");
    expect(screen.getByTestId("export-purpose-social")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("export-purpose-personal")).toHaveTextContent("Personal");
    expect(exportButton()).toBeEnabled();
  });

  it("lists every track with its rights chip; the copyrighted one starts off under Social and says what each platform does", () => {
    renderIt();
    expect(screen.getByTestId("export-audio-chip-song")).toHaveTextContent("©");
    expect(screen.getByTestId("export-audio-chip-clip")).toHaveTextContent("yours");
    expect(screen.getByTestId("export-audio-chip-bed")).toHaveTextContent("libi");
    expect(screen.getByTestId("export-audio-include-song")).not.toBeChecked();
    expect(screen.getByTestId("export-audio-include-clip")).toBeChecked();
    expect(screen.getByTestId("export-audio-platforms-song")).toHaveTextContent("TikTok attaches it at posting · Instagram: left out");
    expect(screen.getByTestId("export-summary")).toHaveTextContent("MP4 · Original · 2 of 3 audio tracks");
  });

  it("including the song in a Social export warns; the request names it and leaves an unticked track out", () => {
    const f = renderIt();
    fireEvent.click(screen.getByTestId("export-audio-include-song"));
    expect(screen.getByTestId("export-copyrighted-warning")).toHaveTextContent(
      "Social platforms may mute, block or claim videos with copyrighted music. Posting from libi attaches the platform's licensed copy instead where it can.",
    );
    fireEvent.click(screen.getByTestId("export-audio-include-clip"));
    fireEvent.click(exportButton());
    expect(f.start).toHaveBeenCalledWith(expect.objectContaining({ purpose: "social", copyrightedAudio: "exclude", includeFileIds: ["song"], excludeFileIds: ["clip"] }));
  });

  it("switching to Personal turns the song on and keeps the user's other toggles", () => {
    renderIt();
    fireEvent.click(screen.getByTestId("export-audio-include-bed"));
    fireEvent.click(screen.getByTestId("export-purpose-personal"));
    expect(screen.getByTestId("export-audio-include-song")).toBeChecked();
    expect(screen.getByTestId("export-audio-include-bed")).not.toBeChecked();
  });

  it("with no copyrighted audio the purpose and the list are still there, as usual", () => {
    const f = renderIt({ tracks: [TRACKS[1]] });
    expect(screen.getByTestId("export-purpose")).toBeInTheDocument();
    expect(screen.getByTestId("export-audio-row-clip")).toBeInTheDocument();
    fireEvent.click(exportButton());
    expect(f.start).toHaveBeenCalledWith(expect.objectContaining({ purpose: "social", includeFileIds: [], excludeFileIds: [] }));
  });

  it("an empty piece says it has no audio", () => {
    renderIt({ tracks: [] });
    expect(screen.getByTestId("export-audio-empty")).toHaveTextContent("This piece has no audio.");
    expect(screen.getByTestId("export-summary")).toHaveTextContent("MP4 · Original · no audio");
  });

  it("re-clicking the already-selected purpose is a no-op — a copyrighted toggle survives", () => {
    renderIt();
    fireEvent.click(screen.getByTestId("export-audio-include-song"));
    expect(screen.getByTestId("export-audio-include-song")).toBeChecked();
    // Social is already selected — clicking it again must not re-apply the
    // Social default and turn the song back off.
    fireEvent.click(screen.getByTestId("export-purpose-social"));
    expect(screen.getByTestId("export-audio-include-song")).toBeChecked();
  });
});

// While the piece's audio rights are still loading (or failed), an EMPTY
// `audioTracks` means "not known yet" — never "no audio". Before this fix,
// `useExportAudioTracks` returned [] during that window, which read as an
// audio-free piece and, on a Personal export, silently dropped the song
// (`audioRequest([], "personal", {})` → `includeFileIds: []`).
describe("ExportDialog — audio rights loading/error (never reads as 'no audio')", () => {
  function renderLoadingOrError(opts: { loading?: boolean; error?: boolean }) {
    const f = flow();
    const onRetry = vi.fn();
    render(
      <ExportDialog
        pieceId="p1"
        pieceName="My piece"
        compositionWidth={1080}
        compositionHeight={1920}
        flow={f}
        hasSnapshot
        hasDraft
        openOverride
        audioTracks={[]}
        audioTracksLoading={opts.loading}
        audioTracksError={opts.error}
        onRetryAudioTracks={onRetry}
      />,
    );
    return { f, onRetry };
  }

  it("loading: shows a skeleton, never the empty-piece message, and disables Export", () => {
    renderLoadingOrError({ loading: true });
    expect(screen.getByTestId("export-audio-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("export-audio-empty")).toBeNull();
    // A skeleton in the footer too — never "Loading…" text (AGENTS.md loading rule).
    expect(screen.getByTestId("export-summary-loading")).toBeInTheDocument();
    expect(screen.queryByText(/Loading/)).toBeNull();
    expect(exportButton()).toBeDisabled();
  });

  it("error: shows a 'Try again' that calls the retry, never the empty-piece message, and disables Export", () => {
    const { onRetry } = renderLoadingOrError({ error: true });
    expect(screen.getByTestId("export-audio-error")).toBeInTheDocument();
    expect(screen.queryByTestId("export-audio-empty")).toBeNull();
    expect(screen.getByTestId("export-summary")).toHaveTextContent("Couldn't load this piece's audio");
    expect(exportButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

// The dialog is ONE long-lived instance in preview-player.tsx (never
// remounted per-open), so `useState(initialPurpose ?? "social")` only ever
// seeds on the component's FIRST mount. These tests mount once and
// `rerender` the SAME instance to reproduce that — a fresh `render()` per
// case (like the suites above) would hide the bug by re-running the
// initializer every time.
describe("ExportDialog — re-seeds purpose each time it opens (one long-lived instance)", () => {
  const dialog = (open: boolean, initialPurpose: "social" | "personal" | null | undefined, f: ReturnType<typeof flow>) => (
    <ExportDialog
      pieceId="p1"
      pieceName="My piece"
      compositionWidth={1080}
      compositionHeight={1920}
      flow={f}
      hasSnapshot
      hasDraft
      openOverride={open}
      audioTracks={TRACKS}
      initialPurpose={initialPurpose}
    />
  );

  it("open, toggle the song on and pick Personal, close, reopen with no purpose: Social selected, song unchecked, request leaves it out", () => {
    const f = flow();
    const { rerender } = render(dialog(true, "social", f));

    fireEvent.click(screen.getByTestId("export-audio-include-song"));
    fireEvent.click(screen.getByTestId("export-purpose-personal"));
    expect(screen.getByTestId("export-purpose-personal")).toHaveAttribute("aria-checked", "true");

    // Close the dialog (still the same instance).
    rerender(dialog(false, "social", f));

    // Reopen with NO purpose requested this time (e.g. a plain manual open) —
    // the "Personal" chosen for the export before it must not carry over.
    rerender(dialog(true, null, f));

    expect(screen.getByTestId("export-purpose-social")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("export-audio-include-song")).not.toBeChecked();
    fireEvent.click(exportButton());
    expect(f.start).toHaveBeenCalledWith(expect.objectContaining({ purpose: "social", includeFileIds: [] }));
  });

  it("open, toggle the song on and pick Personal, close, reopen with initialPurpose='personal': Personal selected, song on", () => {
    const f = flow();
    const { rerender } = render(dialog(true, "social", f));

    fireEvent.click(screen.getByTestId("export-audio-include-song"));
    fireEvent.click(screen.getByTestId("export-purpose-personal"));

    rerender(dialog(false, "social", f));

    // Reopen as the Posting tab's "Export & post" would — asking for "personal" again.
    rerender(dialog(true, "personal", f));

    expect(screen.getByTestId("export-purpose-personal")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("export-audio-include-song")).toBeChecked();
  });
});
