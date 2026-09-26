/**
 * A piece exported to an mp4 for a template's example video — the first step
 * of both the publish preparation (`template_publish_prepare`, when the agent
 * names a piece) and the Templates page's own example (`template_example`).
 * One path, so the example a user sees on their card is made the way the one
 * they would publish is: the normal export renderer, reading ORIGINAL media
 * (`renderExport`, lib/jobs/runners/export.ts).
 *
 * Never through an `export` JOB: that would record an export row for the
 * piece, and the Posting tab's "latest export", `libi.post_piece`'s and the
 * jobs list would then offer a file in a temporary folder that is deleted
 * when the calling job ends — newer than, and hiding, the user's own export
 * (D2–D4 review I1). The render runs inside the calling job instead, which
 * holds the export lane (lib/export/export-lane.ts) while it does.
 *
 * Server-only.
 */
import { loadComposition } from "@/lib/composition/persistence";
import { getExportLane } from "@/lib/export/export-lane";
import { hasGraphicsOverlays, resolveExportSettings } from "@/lib/export/quality";
import { exportRunner, renderExport, type ExportParams } from "@/lib/jobs/runners/export";
import { CancelledError, type JobContext } from "@/lib/jobs/types";

/**
 * Render `pieceId`'s draft into `dest`, forwarding its progress into
 * [from, to]% of `ctx`; returns the mp4's absolute path. The CALLER holds the
 * export lane. `signal` aborting stops the render (ffmpeg is killed, a
 * Chromium render torn down) and rejects with a `CancelledError`.
 */
export async function renderPieceForExample(
  ctx: JobContext<unknown>,
  pieceId: string,
  dest: string,
  signal: AbortSignal,
  from: number,
  to: number,
): Promise<string> {
  const { manifest } = await loadComposition(pieceId);
  // The example is scaled to ≤ 1280 afterwards: native size, 1080p graphics is plenty.
  const settings = resolveExportSettings({
    format: "mp4",
    codec: "avc",
    fps: manifest.fps,
    quality: "source",
    graphicsQuality: "1080p",
    hasGraphics: hasGraphicsOverlays(manifest.overlays),
    sourceWidth: manifest.width,
    sourceHeight: manifest.height,
  });
  const params = exportRunner.paramsSchema.parse({
    pieceId,
    source: "draft",
    filename: "template-example",
    settings: { ...settings },
    destFolder: dest,
  } satisfies ExportParams);
  const render: JobContext<ExportParams> = {
    // The calling job's id: the export's log lines are this job's.
    jobId: ctx.jobId,
    params,
    resumeState: null,
    // The render's own 0–100 %; a first Chromium download's MB ticks are not this job's percentage.
    reportProgress: (done, total, unit) => {
      if (unit === "%" && total > 0) ctx.reportProgress(Math.round(from + ((to - from) * done) / total), 100, "%");
    },
    checkpoint: async () => undefined,
    shouldCancel: () => signal.aborted || ctx.shouldCancel(),
  };
  // The export may first fetch Chromium, silently: that quiet stretch is not
  // this job going silent.
  const releaseWatchdog = ctx.pauseWatchdog?.();
  try {
    const result = await renderExport(render);
    if (signal.aborted) throw new CancelledError(ctx.jobId);
    return result.filePath;
  } catch (err) {
    if (signal.aborted || ctx.shouldCancel()) throw new CancelledError(ctx.jobId);
    throw new Error(`the example export failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    releaseWatchdog?.();
  }
}

/**
 * The publish preparation's export: someone is waiting on it, so it takes the
 * export lane in the FOREGROUND — after any export already running, and
 * ahead of a background example render, which yields to it.
 *
 * Waiting behind the user's own export is not this job going silent: the
 * watchdog is paused from BEFORE the wait (a 5-minute 4K export would
 * otherwise trip the preparation's 180 s timer), and a cancel while it waits
 * leaves the lane's queue at once (fix-round review N2).
 */
export async function exportPieceForExample(
  ctx: JobContext<unknown>,
  pieceId: string,
  dest: string,
  signal: AbortSignal,
  from: number,
  to: number,
): Promise<string> {
  const releaseWatchdog = ctx.pauseWatchdog?.();
  try {
    let release: () => void;
    try {
      release = await getExportLane().foreground({ signal });
    } catch {
      throw new CancelledError(ctx.jobId);
    }
    try {
      if (signal.aborted || ctx.shouldCancel()) throw new CancelledError(ctx.jobId);
      return await renderPieceForExample(ctx, pieceId, dest, signal, from, to);
    } finally {
      release();
    }
  } finally {
    releaseWatchdog?.();
  }
}
