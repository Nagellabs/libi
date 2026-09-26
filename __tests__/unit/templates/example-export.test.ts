// __tests__/unit/templates/example-export.test.ts
//
// Fix-round review N2: a publish preparation's export waits in the export lane
// behind the user's own export. That wait must not trip the preparation's
// no-progress watchdog, and a cancel while it waits must take effect at once,
// leaving the lane's queue. The export renderer itself is replaced.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renderExport = vi.hoisted(() => vi.fn());
vi.mock("@/lib/jobs/runners/export", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/jobs/runners/export")>()), renderExport }));
vi.mock("@/lib/composition/persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/composition/persistence")>()),
  loadComposition: vi.fn(async () => ({ manifest: { width: 1080, height: 1920, fps: 30, overlays: [], audioClips: [] } })),
}));

import { getExportLane } from "@/lib/export/export-lane";
import { CancelledError, type JobContext } from "@/lib/jobs/types";
import { exportPieceForExample } from "@/lib/templates/example-export";

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
  delete (globalThis as { __libiExportLane?: unknown }).__libiExportLane;
  renderExport.mockReset().mockResolvedValue({ filePath: "/tmp/x.mp4" });
});
afterEach(() => vi.restoreAllMocks());

describe("exportPieceForExample — waiting behind the user's export", () => {
  it("holds the watchdog pause for the whole wait, renders once the lane is free, then releases it", async () => {
    const userExport = await getExportLane().foreground();
    const run = exportPieceForExample(ctx(), "piece-1", "/tmp/dest", new AbortController().signal, 5, 60);
    await new Promise((r) => setTimeout(r, 30));
    expect(pauses).toBe(1); // excused while it waits
    expect(renderExport).not.toHaveBeenCalled();
    userExport();
    await expect(run).resolves.toBe("/tmp/x.mp4");
    expect(renderExport).toHaveBeenCalledTimes(1);
    expect(pauses).toBe(0);
  });

  it("a cancel while it waits ends it at once — no render — and leaves no place in the queue", async () => {
    const userExport = await getExportLane().foreground();
    const ac = new AbortController();
    const run = exportPieceForExample(ctx(), "piece-1", "/tmp/dest", ac.signal, 5, 60);
    await new Promise((r) => setTimeout(r, 10));
    const at = Date.now();
    ac.abort();
    await expect(run).rejects.toBeInstanceOf(CancelledError);
    expect(Date.now() - at).toBeLessThan(200);
    expect(renderExport).not.toHaveBeenCalled();
    expect(pauses).toBe(0);
    userExport();
    // The lane is free again at once: nobody queued behind the cancelled wait.
    const again = await Promise.race([getExportLane().foreground(), new Promise<null>((r) => setTimeout(() => r(null), 100))]);
    expect(again).not.toBeNull();
    again!();
  });
});
