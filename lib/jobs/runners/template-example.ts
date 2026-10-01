/**
 * `template_example` — a playable example for a template on the Templates
 * page: the template's source piece exported, cut to the example caps
 * (≤ 15 s, ≤ 1280 px long edge; `transcodeExample`) and a poster at 1.0 s
 * (`makePoster`), written into the template folder as example.mp4 +
 * poster.jpg (`setTemplateExample`). The same export and the same media rules
 * as a publish preparation (`template_publish_prepare`), so what the card
 * plays is what a publish would show.
 *
 * Started in the background by `libi.create_template_from_piece` (through
 * `POST /api/jobs`), and by the page's "Render preview"
 * (`POST /api/templates/<id>/example`). Nothing leaves the machine.
 *
 * Nobody waits on it, so it never costs the user an export (D2–D4 review
 * I1, I2):
 *  - the piece is rendered by the export renderer INSIDE this job — no
 *    `export` row is recorded, so nothing lists it as the piece's export;
 *  - it takes a BACKGROUND slot of the export scheduler (lib/export/scheduler.ts):
 *    it starts only while no export the user asked for runs or waits, and
 *    the moment one arrives it stops, lets that export start, and renders
 *    again from the start once the machine is free. At most one runs at a time.
 *
 * Refused — before any work — for a template whose source piece is gone, and
 * for an installed template, whose example is its author's. A source piece
 * deleted while it renders fails it the same way, with nothing written.
 *
 * A piece with nothing to export (no overlays, no audio — checked LIVE,
 * before and after the export scheduler wait) is not a failure: the run completes
 * with no example written, logged at info level (TPL-3 Important-1). Letting
 * this reach `renderPieceForExample`/`classifyExportShape` would refuse
 * "nothing to export", which `JobManager` always logs as an error-level
 * `jobs.run.failed` — exactly the noise TPL-3 set out to remove. The manual
 * "Render preview" route (`app/api/templates/[id]/example/route.ts`) makes
 * the same check before ever enqueueing, so a user sees a clear 409 instead.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod/v3";
import { BACKGROUND_EXAMPLE_ESTIMATE, getExportScheduler, type Reservation } from "@/lib/export/scheduler";
import { getJobManager } from "@/lib/jobs/manager";
import { CancelledError, type JobContext, type JobRunner } from "@/lib/jobs/types";
import { trackServerEvent } from "@/lib/analytics/server";
import { serverLogger as logger } from "@/lib/logger";
import { navigationEmitter } from "@/lib/navigation-events";
import { makePoster, transcodeExample } from "@/lib/templates/cloud/publish-media";
import { pieceHasNothingToExport, renderPieceForExample } from "@/lib/templates/example-export";
import { getTemplate, setTemplateExample, sourcePieceExists, TEMPLATES_LOG_TAG } from "@/lib/templates/store";

export const SOURCE_PIECE_GONE = "This template's source piece is gone, so its preview can't be rendered.";
export const INSTALLED_KEEPS_EXAMPLE = "An installed template keeps its author's example; its preview isn't rendered here.";
/** Said by the manual "Render preview" route (TPL-3 Important-1): the current piece has no
 *  overlays and no audio, so there is nothing the export renderer could read. A clear 409,
 *  never a job started only to fail against the classifier's "nothing to export". */
export const SOURCE_PIECE_EMPTY = "The piece is empty — add something to it first.";
/** Not an error: a normal, expected outcome logged at info level (TPL-3 Important-1). */
export const PIECE_EMPTIED_SKIP_LOG = "the source piece has nothing to export; skipped rather than asking the classifier to refuse it";

const CANCEL_POLL_MS = 500;

const paramsSchema = z.object({ templateId: z.string().min(1) }).strict();
export type TemplateExampleParams = z.infer<typeof paramsSchema>;

export interface TemplateExampleResult {
  templateId: string;
  exampleBytes: number;
  posterBytes: number;
}

function checkCancel(ctx: JobContext<TemplateExampleParams>): void {
  if (ctx.shouldCancel()) throw new CancelledError(ctx.jobId);
}

/** A user's export job is active or queued — the scheduler holds the background render back rather than start it and yield at once. */
function userExportsPending(): boolean {
  return getJobManager().activeOrWaiting("export") > 0;
}

export const templateExampleRunner: JobRunner<TemplateExampleParams, TemplateExampleResult> = {
  kind: "template_example",
  // One background render at a time; the export scheduler keeps it behind the user's exports too.
  maxConcurrent: 1,
  paramsSchema: paramsSchema as unknown as z.ZodSchema<TemplateExampleParams>,
  // A restart renders nothing half-way: the work folder is temporary, and "Render preview" starts again.
  resumable: false,
  // The same template asked twice (the agent's create, then a click) attaches to the render in flight.
  exclusiveResource: true,
  noProgressTimeoutMs: 180_000,
  async run(ctx) {
    const { templateId } = ctx.params;
    const row = getTemplate(templateId);
    if (!row) throw new Error("template_not_found");
    if (row.origin !== "local") throw new Error(INSTALLED_KEEPS_EXAMPLE);
    const pieceId = row.createdFromPieceId;
    if (!sourcePieceExists(pieceId)) throw new Error(SOURCE_PIECE_GONE);
    // Checked live, not from the frozen scaffold `sourceEmpty` (lib/templates/store.ts):
    // a piece that was non-empty when the template was made can be emptied afterwards.
    // Never let this reach `renderPieceForExample`/`classifyExportShape` — that refusal
    // is an unconditional error-level `jobs.run.failed` (lib/jobs/manager.ts) for what is
    // an expected case, exactly what TPL-3 set out to remove.
    if (await pieceHasNothingToExport(pieceId)) {
      logger.info({ tag: TEMPLATES_LOG_TAG, op: "example_skipped_empty", templateId }, PIECE_EMPTIED_SKIP_LOG);
      return { templateId, exampleBytes: 0, posterBytes: 0 };
    }
    ctx.reportProgress(2, 100, "%");
    // Only forward: a render that yielded and starts again does not walk the bar back.
    let high = 2;
    const report = (done: number) => {
      if (done <= high) return;
      high = done;
      ctx.reportProgress(done, 100, "%");
    };
    const progressCtx: JobContext<unknown> = { ...(ctx as JobContext<unknown>), reportProgress: (done) => report(done) };

    const work = path.join(os.tmpdir(), `libi-template-example-work-${ctx.jobId}`);
    const abort = new AbortController();
    const cancelPoll = setInterval(() => {
      if (ctx.shouldCancel() && !abort.signal.aborted) abort.abort();
    }, CANCEL_POLL_MS);
    const scheduler = getExportScheduler();
    try {
      let example: Awaited<ReturnType<typeof transcodeExample>>;
      let poster: Awaited<ReturnType<typeof makePoster>>;
      const examplePath = path.join(work, "example.mp4");
      const posterPath = path.join(work, "poster.jpg");
      for (let attempt = 1; ; attempt++) {
        // Waiting for a user's export is not this job going silent.
        const releaseWatchdog = ctx.pauseWatchdog?.();
        let slot: Reservation;
        try {
          slot = await scheduler.acquire({
            id: `template_example:${ctx.jobId}:${attempt}`,
            priority: "background",
            estimate: BACKGROUND_EXAMPLE_ESTIMATE,
            signal: abort.signal,
            busy: userExportsPending,
          });
        } catch {
          throw new CancelledError(ctx.jobId);
        } finally {
          releaseWatchdog?.();
        }
        const signal = AbortSignal.any([abort.signal, slot.signal]);
        try {
          // Re-checked after the export scheduler wait (which can be long, behind a
          // user's own export): the piece may have been emptied while queued.
          if (await pieceHasNothingToExport(pieceId)) {
            logger.info({ tag: TEMPLATES_LOG_TAG, op: "example_skipped_empty", templateId, attempt }, PIECE_EMPTIED_SKIP_LOG);
            return { templateId, exampleBytes: 0, posterBytes: 0 };
          }
          await fsp.rm(work, { recursive: true, force: true });
          await fsp.mkdir(work, { recursive: true });
          const source = await renderPieceForExample(progressCtx, pieceId, path.join(work, "export"), signal, 2, 60, { reservation: slot });
          report(60);
          example = await transcodeExample(source, examplePath, {
            signal,
            onProgress: (r) => report(60 + Math.round(r * 30)),
          });
          report(90);
          poster = await makePoster(source, posterPath, { signal });
          if (signal.aborted) throw new CancelledError(ctx.jobId);
          break;
        } catch (err) {
          if (abort.signal.aborted || ctx.shouldCancel()) throw new CancelledError(ctx.jobId);
          // A render that failed because its source piece was deleted under it says so, not "the export failed: …" (final review F9).
          if (!sourcePieceExists(pieceId)) throw new Error(SOURCE_PIECE_GONE);
          if (!slot.signal.aborted) throw err;
          // A user's export took the machine: let it run, then render again from the start.
          logger.info({ tag: TEMPLATES_LOG_TAG, op: "example_yielded", templateId, attempt }, "template example render yielded to an export");
        } finally {
          slot.release();
        }
      }
      checkCancel(ctx);
      // A source piece deleted mid-render: its media may have gone part-way through.
      if (!sourcePieceExists(pieceId)) throw new Error(SOURCE_PIECE_GONE);
      report(95);
      await setTemplateExample(templateId, examplePath, posterPath);
      navigationEmitter.emit("refresh_query", { queryKey: "templates" });
      logger.info({ tag: TEMPLATES_LOG_TAG, op: "example_rendered", templateId, bytes: example.bytes }, "template example rendered");
      trackServerEvent("template_preview_rendered");
      report(100);
      return { templateId, exampleBytes: example.bytes, posterBytes: poster.bytes };
    } finally {
      clearInterval(cancelPoll);
      await fsp.rm(work, { recursive: true, force: true });
    }
  },
};
