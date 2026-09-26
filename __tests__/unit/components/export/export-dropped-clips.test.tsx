// @vitest-environment jsdom
// F13 UI: a video clip that could not be loaded is left out of the export, and the export still
// succeeds. The agent's result already named it; the export screen now does too — on the dialog's
// success card, and on the toast shown when the dialog was closed at finish (which then stays up
// until dismissed instead of timing out unread).
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

vi.mock("@/lib/queries/export-defaults", () => ({ useExportDefaults: () => ({ data: undefined }) }));
vi.mock("@/lib/shell/client", () => ({
  revealFile: vi.fn(),
  pickDirectory: vi.fn(async () => undefined),
  hasElectronBridge: () => false,
}));
vi.mock("@/lib/queries/social", () => ({ useSocialStatus: () => ({ data: { providerId: null } }) }));
vi.mock("@/hooks/social/use-posting-intent", () => ({ openPostingTab: vi.fn() }));

import { ExportDialog } from "@/components/export/export-dialog";
import { ExportSuccessToast, exportToastFor } from "@/components/export/export-success-toast";
import { readFileSync } from "node:fs";
import type { UseExportFlowResult, ExportSuccess } from "@/hooks/editor/use-export-flow";

const BASE: ExportSuccess = {
  filePath: "/exports/my-piece.mp4",
  sizeBytes: 1_234_567,
  durationSeconds: 12,
  backend: "chromium-render",
  width: 1080,
  height: 1920,
};

function renderSuccess(result: ExportSuccess) {
  const flow = {
    status: "success",
    progress: null,
    result,
    error: null,
    jobId: "job_1",
    start: vi.fn(),
    cancel: vi.fn(async () => {}),
    reset: vi.fn(),
  } as unknown as UseExportFlowResult;
  return render(
    <ExportDialog
      pieceId="p1"
      pieceName="My piece"
      compositionWidth={1080}
      compositionHeight={1920}
      flow={flow}
      hasSnapshot
      hasDraft
      openOverride
    />,
  );
}

describe("ExportDialog success card — clips the export went without", () => {
  it("names the clip that couldn't be played", () => {
    renderSuccess({
      ...BASE,
      droppedOverlays: [
        { id: "vid-1", message: "its video could not be loaded", kind: "video", fileId: "f1", name: "beach.mp4" },
      ],
    });
    const note = screen.getByTestId("export-dropped-clips");
    expect(note).toHaveTextContent("Exported without 1 clip: “beach.mp4” couldn't be played.");
    expect(note).toHaveTextContent("replace the clip, then export again");
    // Still a success: the file was written.
    expect(screen.getByText("Saved my-piece.mp4")).toBeInTheDocument();
  });

  it("says nothing when nothing was dropped, or only a code overlay was", () => {
    const { unmount } = renderSuccess(BASE);
    expect(screen.queryByTestId("export-dropped-clips")).toBeNull();
    unmount();
    renderSuccess({ ...BASE, droppedOverlays: [{ id: "code-1", message: "render: boom" }] });
    expect(screen.queryByTestId("export-dropped-clips")).toBeNull();
  });
});

describe("ExportSuccessToast — the note", () => {
  afterEach(() => vi.useRealTimers());

  it("shows the note and stays up past the 10s auto-dismiss", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <ExportSuccessToast
        filename="my-piece.mp4"
        onOpenFolder={() => {}}
        onDismiss={onDismiss}
        note="Exported without 1 clip: “beach.mp4” couldn't be played."
      />,
    );
    expect(screen.getByTestId("export-toast-dropped-clips")).toHaveTextContent("“beach.mp4” couldn't be played");
    act(() => vi.advanceTimersByTime(15_000));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("without a note, auto-dismisses after 10s as before", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<ExportSuccessToast filename="my-piece.mp4" onOpenFolder={() => {}} onDismiss={onDismiss} />);
    expect(screen.queryByTestId("export-toast-dropped-clips")).toBeNull();
    act(() => vi.advanceTimersByTime(10_000));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

// The post-close toast's wiring in preview-player.tsx. PreviewPlayer is far too heavy to mount in
// jsdom (see transform-ui-playback-gate.test.tsx), so: the state it builds comes from the pure
// `exportToastFor`, tested here, and a source scan pins that the player uses it on the success
// edge and hands its `note` to the toast.
describe("the post-close toast's state (preview-player)", () => {
  it("carries the file and the dropped-clips note", () => {
    expect(
      exportToastFor({
        ...BASE,
        filePath: "C:\\exports\\my-piece.mp4",
        droppedOverlays: [
          { id: "v1", message: "m", kind: "video", cause: "load", fileId: "f1", name: "beach.mp4" },
          { id: "v2", message: "m", kind: "video", cause: "load", fileId: "f1", name: "beach.mp4" },
        ],
      }),
    ).toEqual({
      filePath: "C:\\exports\\my-piece.mp4",
      filename: "my-piece.mp4",
      note: "Exported without 1 clip: “beach.mp4” couldn't be played.",
    });
    expect(exportToastFor(BASE).note).toBeNull();
  });

  it("preview-player builds the toast with exportToastFor and passes its note", () => {
    const src = readFileSync("components/preview/preview-player.tsx", "utf-8");
    expect(src).toMatch(/becameSuccess[\s\S]{0,200}setExportToast\(exportToastFor\(exportFlow\.result\)\)/);
    expect(src).toMatch(/<ExportSuccessToast[\s\S]{0,200}note=\{exportToast\.note\}/);
  });
});
