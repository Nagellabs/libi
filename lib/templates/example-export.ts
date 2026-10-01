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
 * (D2–D4 review I1). The render runs inside the calling job instead, admitted
 * by the export scheduler (lib/export/scheduler.ts) like any other render.
 *
 * Server-only.
 */
import { loadComposition } from "@/lib/composition/persistence";
import type { Reservation } from "@/lib/export/scheduler";
import { hasGraphicsOverlays, resolveExportSettings } from "@/lib/export/quality";
import { exportRunner, renderExport, type ExportParams } from "@/lib/jobs/runners/export";
import { CancelledError, type JobContext } from "@/lib/jobs/types";

/**
 * Whether `pieceId`'s CURRENT manifest has nothing to export — no overlays
 * and no audio clips, the same condition `classifyExportShape` (D2–D4
 * review Important-1 on TPL-3) refuses as "nothing to export". Read straight
 * off the manifest so both the manual "Render preview" route
 * (app/api/templates/[id]/example/route.ts) and the `template_example`
 * runner can refuse BEFORE calling `renderPieceForExample` — the render
 * never reaches the classifier for an empty piece, so it never fails a job
 * with an error-level `jobs.run.failed` for what is an expected case.
 * `libi.create_template_from_piece` makes the same check against the
 * scaffold it just captured (`sourceEmpty`, lib/templates/store.ts); this is
 * the live-piece counterpart, for a piece that was non-empty at creation and
 * was emptied since.
 */
export async function pieceHasNothingToExport(pieceId: string): Promise<boolean> {
  const { manifest } = await loadComposition(pieceId);
  return (manifest.overlays?.length ?? 0) === 0 && (manifest.audioClips?.length ?? 0) === 0;
}

/**
 * Render `pieceId`'s draft into `dest`, forwarding its progress into
 * [from, to]% of `ctx`; returns the mp4's absolute path. With a `reservation`
 * (a background example render, which took its slot before calling) the render
 * is not admitted again; without one the export scheduler admits it in the
 * foreground. `signal` aborting stops the render (ffmpeg is killed, a
 * Chromium render torn down) and rejects with a `CancelledError`.
 */
export async function renderPieceForExample(
  ctx: JobContext<unknown>,
  pieceId: string,
  dest: string,
  signal: AbortSignal,
  from: number,
  to: number,
  opts: { reservation?: Reservation } = {},
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
  // A published template's example video is public. `purpose: "social"`
  // (→ copyrightedAudio "exclude", lib/export/audio-policy.ts) keeps any
  // copyrighted song out of it; with no purpose the runner refuses a piece
  // that has one (the purpose question), so the example would never render.
  const audioOpts: Pick<ExportParams["settings"], "purpose"> = { purpose: "social" };
  const params = exportRunner.paramsSchema.parse({
    pieceId,
    source: "draft",
    filename: "template-example",
    settings: { ...settings, ...audioOpts },
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
    const result = await renderExport(render, { kind: "dir", dir: dest }, { reservation: opts.reservation, priority: "foreground", schedulerId: ctx.jobId });
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
 * The publish preparation's export: someone is waiting on it, so the export
 * scheduler admits it in the FOREGROUND — after the exports already running
 * have taken what they need, and ahead of a background example render, which
 * yields to it.
 *
 * Waiting behind the user's own export is not this job going silent: the
 * watchdog is paused around all of it (a 5-minute 4K export would otherwise
 * trip the preparation's 180 s timer), and a cancel while it waits leaves the
 * scheduler's queue at once.
 */
export async function exportPieceForExample(
  ctx: JobContext<unknown>,
  pieceId: string,
  dest: string,
  signal: AbortSignal,
  from: number,
  to: number,
): Promise<string> {
  // The wait for a slot now happens inside renderExport (the export
  // scheduler, foreground): waiting behind the user's exports is not this job
  // going silent, so the watchdog is paused around all of it.
  const releaseWatchdog = ctx.pauseWatchdog?.();
  try {
    if (signal.aborted || ctx.shouldCancel()) throw new CancelledError(ctx.jobId);
    return await renderPieceForExample(ctx, pieceId, dest, signal, from, to);
  } finally {
    releaseWatchdog?.();
  }
}
