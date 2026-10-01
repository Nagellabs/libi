// __tests__/unit/templates/example-export.test.ts
//
// A publish preparation's export is admitted by the export scheduler inside
// renderExport, in the foreground. The wait for a slot must not trip the
// preparation's no-progress watchdog, so the pause covers the whole render.
// The export renderer itself is replaced.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renderExport = vi.hoisted(() => vi.fn());
vi.mock("@/lib/jobs/runners/export", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/jobs/runners/export")>()), renderExport }));
vi.mock("@/lib/composition/persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/composition/persistence")>()),
  loadComposition: vi.fn(async () => ({ manifest: { width: 1080, height: 1920, fps: 30, overlays: [], audioClips: [] } })),
}));

import { loadComposition } from "@/lib/composition/persistence";
import { CancelledError, type JobContext } from "@/lib/jobs/types";
import { exportPieceForExample, pieceHasNothingToExport } from "@/lib/templates/example-export";

let pauses = 0;
function ctx(): JobContext<unknown> {
  return {
    jobId: "prepare-1",
    params: {},
    resumeState: null,
    reportProgress: () => {},
    checkpoint: async () => {},
    shouldCancel: () => false,
    pauseWatchdog: () => {
      pauses++;
      let done = false;
      return () => {
        if (!done) pauses--;
        done = true;
      };
    },
  };
}

beforeEach(() => {
  pauses = 0;
  renderExport.mockReset().mockResolvedValue({ filePath: "/tmp/x.mp4" });
});
afterEach(() => vi.restoreAllMocks());

describe("exportPieceForExample — a foreground render", () => {
  it("renders into its folder in the foreground, with the watchdog paused for the whole render (a wait in the scheduler included)", async () => {
    let pausedDuringRender = -1;
    renderExport.mockImplementation(async () => {
      pausedDuringRender = pauses;
      return { filePath: "/tmp/x.mp4" };
    });
    const out = await exportPieceForExample(ctx(), "p1", "/tmp/dest", new AbortController().signal, 5, 60);
    expect(out).toBe("/tmp/x.mp4");
    expect(pausedDuringRender).toBeGreaterThan(0);
    expect(pauses).toBe(0);
    expect(renderExport).toHaveBeenCalledWith(expect.anything(), { kind: "dir", dir: "/tmp/dest" }, expect.objectContaining({ priority: "foreground" }));
  });

  it("an already-cancelled preparation renders nothing", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(exportPieceForExample(ctx(), "p1", "/tmp/dest", ac.signal, 5, 60)).rejects.toBeInstanceOf(CancelledError);
    expect(renderExport).not.toHaveBeenCalled();
    expect(pauses).toBe(0);
  });
});

// TPL-3 Important-1: a piece emptied AFTER its template was made must be
// caught before either the manual "Render preview" route or the
// template_example runner ever calls renderPieceForExample — reading the
// classifier's own "nothing to export" refusal there always fails the job
// with an error-level jobs.run.failed for what is an expected case.
describe("pieceHasNothingToExport", () => {
  it("true for no overlays and no audio clips", async () => {
    vi.mocked(loadComposition).mockResolvedValueOnce({
      manifest: { width: 1080, height: 1920, fps: 30, overlays: [], audioClips: [] } as never,
      legacyScenes: 0,
    });
    expect(await pieceHasNothingToExport("piece-1")).toBe(true);
  });

  it("false with at least one overlay", async () => {
    vi.mocked(loadComposition).mockResolvedValueOnce({
      manifest: { width: 1080, height: 1920, fps: 30, overlays: [{ id: "o1" }], audioClips: [] } as never,
      legacyScenes: 0,
    });
    expect(await pieceHasNothingToExport("piece-1")).toBe(false);
  });

  it("false with at least one audio clip and no overlays (matches the classifier: audio alone exports)", async () => {
    vi.mocked(loadComposition).mockResolvedValueOnce({
      manifest: { width: 1080, height: 1920, fps: 30, overlays: [], audioClips: [{ id: "a1" }] } as never,
      legacyScenes: 0,
    });
    expect(await pieceHasNothingToExport("piece-1")).toBe(false);
  });
});
