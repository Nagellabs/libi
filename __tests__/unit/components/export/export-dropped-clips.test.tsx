// F13 UI: a video clip that could not be loaded is left out of the export, and the export still
// succeeds. The note naming it now rides on the app-wide finish toast
// (__tests__/unit/hooks/use-export-finish-toasts.test.tsx), which stays up until dismissed instead of
// timing out unread. What is pinned here is the preview player's wiring into the export dialog and
// the canvas bar.
//
// PreviewPlayer is far too heavy to mount in jsdom (see transform-ui-playback-gate.test.tsx), so
// these are source scans.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("the canvas bar (preview-player)", () => {
  it("follows the piece's latest running export record, not the dialog's flow", () => {
    const src = readFileSync("components/preview/preview-player.tsx", "utf-8");
    expect(src).toMatch(/const runningExport = useLatestRunningExport\(pieceId \|\| null\)/);
    expect(src).toMatch(/const isExporting = runningExport !== null/);
    expect(src).not.toMatch(/exportFlow\.progress/);
  });
});

// The export dialog's loading/error state (review fix, task 11): the piece's
// audio rights loading or erroring must never read as "no audio" (an
// EMPTY audioTracks means "not known yet", not "the piece is silent") — the
// dialog's rendering of loading/error/disabled-Export is tested directly in
// export-dialog-purpose.test.tsx. PreviewPlayer is too heavy to mount here
// (see above), so this pins that it wires useExportAudioTracks'
// isLoading/isError/refetch straight through to the dialog rather than
// dropping them.
describe("the export dialog's audio loading/error wiring (preview-player)", () => {
  it("passes useExportAudioTracks' isLoading/isError/refetch to the dialog", () => {
    const src = readFileSync("components/preview/preview-player.tsx", "utf-8");
    expect(src).toMatch(/const exportAudio = useExportAudioTracks\(/);
    expect(src).toMatch(/<ExportDialog[\s\S]{0,1200}audioTracks=\{exportAudio\.tracks\}/);
    expect(src).toMatch(/audioTracksLoading=\{exportAudio\.isLoading\}/);
    expect(src).toMatch(/audioTracksError=\{exportAudio\.isError\}/);
    expect(src).toMatch(/onRetryAudioTracks=\{exportAudio\.refetch\}/);
  });
});
