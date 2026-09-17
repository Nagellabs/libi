/**
 * Integration: the unified `export` runner's `ensure-chromium` step.
 * Chromium left Category A, so the first export the classifier
 * routes to `chromium-render` has to fetch it — BEFORE the output path is
 * claimed (a failed or cancelled download must leave no placeholder behind),
 * reporting bytes in "MB" as its own phase, then checkpointing so a resumed
 * job does not re-advertise a download that already happened.
 *
 * `ensureChromium` and the ChromiumRenderBackend are stubbed: no download, no
 * browser. What is real is the runner, the classifier (a code overlay forces
 * the chromium branch), the DB and the storage layout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { resetStorage } from "@/lib/storage";
import { getLibiStorageDir } from "@/lib/libi-home";
import { getDb } from "@/lib/db/client";
import type { JobContext } from "@/lib/jobs/types";

const ensure = vi.hoisted(() => ({
  ensureChromium: vi.fn(),
}));
vi.mock("@/lib/export/ensure-chromium", async (orig) => ({
  ...(await orig<typeof import("@/lib/export/ensure-chromium")>()),
  ensureChromium: ensure.ensureChromium,
}));
// `claimExportPath` sits between the cancel-poll interval's creation and the
// backend's `finally`; one case makes it throw to prove the interval is
// cleared on that exit too. Everything else keeps the real implementation.
const claim = vi.hoisted(() => ({ throwWith: null as Error | null }));
vi.mock("@/lib/export/filename", async (orig) => {
  const actual = await orig<typeof import("@/lib/export/filename")>();
  return {
    ...actual,
    claimExportPath: (...args: Parameters<typeof actual.claimExportPath>) => {
      if (claim.throwWith) throw claim.throwWith;
      return actual.claimExportPath(...args);
    },
  };
});
vi.mock("@/lib/export/backends/chromium-render", () => ({
  ChromiumRenderBackend: class {
    name = "chromium-render";
    async run() {
      return { blob: new Blob([new Uint8Array([0, 1])]), duration: 2 };
    }
  },
}));

import { exportRunner, type ExportParams } from "@/lib/jobs/runners/export";
import { loadManifest, saveManifest } from "@/lib/composition/persistence";

const PIECE_ID = "p-export-ensure-chromium";

type Progress = [number, number, string | undefined];

function fakeCtx(
  params: ExportParams,
  sink: { progress: Progress[]; checkpoints: unknown[] },
  shouldCancel: () => boolean = () => false,
): JobContext<ExportParams> {
  return {
    jobId: "job-test",
    params,
    resumeState: null,
    reportProgress: (done, total, unit) => sink.progress.push([done, total, unit]),
    checkpoint: async (state) => {
      sink.checkpoints.push(state);
    },
    shouldCancel,
  };
}

function params(destFolder: string): ExportParams {
  return {
    pieceId: PIECE_ID,
    source: "draft",
    filename: "out",
    destFolder,
    settings: {
      format: "mp4", codec: "avc", bitrate: 1_000_000,
      width: 320, height: 240, fps: 24,
    },
  } as ExportParams;
}

/** One full-frame code overlay: its JS draw fn is what forces chromium-render. */
async function seedCodeOverlay(): Promise<void> {
  const m = await loadManifest(PIECE_ID);
  m.width = 320;
  m.height = 240;
  m.fps = 24;
  m.overlays = [
    {
      id: "code-bg", kind: "code", displayName: "backdrop",
      startTime: 0, duration: 2, z: -1, opacity: 1,
      rect: { x: 0, y: 0, width: 320, height: 240 }, drawFunction: "// draw",
    },
  ] as typeof m.overlays;
  m.audioClips = [];
  await saveManifest(PIECE_ID, m);
}

describe("export runner — ensure-chromium step", () => {
  let outDir: string;
  let sink: { progress: Progress[]; checkpoints: unknown[] };

  beforeEach(async () => {
    ensure.ensureChromium.mockReset();
    claim.throwWith = null;
    createTestDb();
    createTempStorageDir();
    resetStorage();
    seedPiece(getDb() as never, { id: PIECE_ID });
    fs.mkdirSync(path.join(getLibiStorageDir(), PIECE_ID), { recursive: true });
    outDir = path.join(getLibiStorageDir(), "export-out");
    sink = { progress: [], checkpoints: [] };
    await seedCodeOverlay();
  });

  afterEach(() => {
    cleanupTempDir();
    resetTestDb();
    resetStorage();
  });

  it("downloads before claiming the output path, reports the download in MB then the render in %, and checkpoints", async () => {
    let filesInOutDirDuringDownload: string[] | null = null;
    ensure.ensureChromium.mockImplementation(
      async (opts: { onProgress?: (p: { doneMb: number; totalMb: number }) => void }) => {
        filesInOutDirDuringDownload = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
        opts.onProgress?.({ doneMb: 0, totalMb: 173 });
        opts.onProgress?.({ doneMb: 87, totalMb: 173 });
        opts.onProgress?.({ doneMb: 173, totalMb: 173 });
      },
    );

    const result = await exportRunner.run(fakeCtx(params(outDir), sink));

    expect(result.backend).toBe("chromium-render");
    expect(ensure.ensureChromium).toHaveBeenCalledTimes(1);
    expect(ensure.ensureChromium.mock.calls[0]![0]).toMatchObject({
      shouldCancel: expect.any(Function),
      onProgress: expect.any(Function),
      // The job's own abort signal (the one the render backends get) reaches
      // the download too, so a cancel does not wait for the 500 ms poll.
      signal: expect.any(AbortSignal),
    });
    // Nothing claimed while the download ran: a cancelled download must not
    // leave `out.mp4` (or a collision-suffixed sibling) in the user's folder.
    expect(filesInOutDirDuringDownload).toEqual([]);
    // Two honest phases: "0/173 MB" … "173/173 MB" — every MB tick comes
    // from the download itself — then the render's 0..100 %.
    expect(sink.progress.slice(0, 3)).toEqual([
      [0, 173, "MB"],
      [87, 173, "MB"],
      [173, 173, "MB"],
    ]);
    expect(sink.progress[3]).toEqual([0, 100, "%"]);
    expect(sink.progress.at(-1)).toEqual([100, 100, "%"]);
    expect(sink.checkpoints).toEqual([{ chromiumReady: true }]);
    expect(fs.existsSync(result.filePath)).toBe(true);
  });

  it("an export with Chromium already present reports no MB phase at all", async () => {
    // The review found a phantom "0/173 MB" tick emitted before ensureChromium
    // had even checked the disk — a user with Chromium installed saw a
    // download bar flash on every canvas export. The MB phase is driven by
    // ensureChromium's own progress callbacks, so a short-circuit reports
    // nothing.
    ensure.ensureChromium.mockResolvedValue(undefined);

    const result = await exportRunner.run(fakeCtx(params(outDir), sink));

    expect(result.backend).toBe("chromium-render");
    expect(sink.progress.some(([, , unit]) => unit === "MB")).toBe(false);
    expect(sink.progress[0]).toEqual([0, 100, "%"]);
    expect(sink.checkpoints).toEqual([{ chromiumReady: true }]);
  });

  it("a failed download fails the export and leaves no file behind", async () => {
    ensure.ensureChromium.mockRejectedValue(
      new Error("playwright install chromium exited 1: ECONNRESET"),
    );
    await expect(exportRunner.run(fakeCtx(params(outDir), sink))).rejects.toThrow(
      /exited 1: ECONNRESET/,
    );
    expect(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []).toEqual([]);
    expect(sink.checkpoints).toEqual([]);
  });

  it("clears the cancel poll when claiming the output path throws (no leaked interval)", async () => {
    // The interval is created before ensureChromium and was cleared on the
    // ensure step's failure and in the backend's finally — but a throw from
    // claimExportPath, between the two, leaked it: shouldCancel kept being
    // polled every 500 ms for a job that had already failed.
    ensure.ensureChromium.mockResolvedValue(undefined);
    claim.throwWith = new Error("EACCES: destination not writable");
    const shouldCancel = vi.fn(() => false);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await expect(
        exportRunner.run(fakeCtx(params(outDir), sink, shouldCancel)),
      ).rejects.toThrow(/EACCES/);
      const callsAtFailure = shouldCancel.mock.calls.length;
      vi.advanceTimersByTime(5_000);
      expect(shouldCancel.mock.calls.length).toBe(callsAtFailure);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []).toEqual([]);
  });

  it("a download cancelled through the job's cancel handle stops the export before any render", async () => {
    let cancelled = false;
    ensure.ensureChromium.mockImplementation(async (opts: { shouldCancel?: () => boolean }) => {
      cancelled = true;
      // What the real ensureChromium does when its poll sees the flag.
      if (opts.shouldCancel?.()) throw new Error("chromium install cancelled");
    });
    await expect(
      exportRunner.run(fakeCtx(params(outDir), sink, () => cancelled)),
    ).rejects.toThrow(/cancelled/);
    expect(sink.progress.some(([, , unit]) => unit === "%")).toBe(false);
    expect(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []).toEqual([]);
  });
});
