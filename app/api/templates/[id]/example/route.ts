import { NextResponse } from "next/server";
import { getJobManager } from "@/lib/jobs/manager";
import { INSTALLED_KEEPS_EXAMPLE, SOURCE_PIECE_EMPTY, SOURCE_PIECE_GONE } from "@/lib/jobs/runners/template-example";
import { trackServerEvent } from "@/lib/analytics/server";
import { serverLogger as logger } from "@/lib/logger";
import { isSafePieceId } from "@/lib/security/pieceId";
import { pieceHasNothingToExport } from "@/lib/templates/example-export";
import { getTemplate, sourcePieceExists, TEMPLATES_LOG_TAG } from "@/lib/templates/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Said when the job could not be started at all — the cause is in the log, never in the answer. */
const RENDER_START_FAILED = "Couldn't start the preview render. Try again, or restart libi if it keeps failing.";

/**
 * POST /api/templates/<id>/example — the Templates page's "Render preview":
 * start the `template_example` job for a local template, 202 `{ jobId }`.
 * The job RUNS: enqueueing only inserts a queued row, so this schedules
 * `runToCompletion` in the background, as every other job-starting route does
 * (`/api/jobs`, `/api/export`) — without it the card said "Rendering
 * preview…" forever (D2–D4 review C1).
 * `forceNew`, so a finished render is never answered from its cached row;
 * a render already in flight is attached to (the runner's `exclusiveResource`).
 * No `pieceId` on the row: a job scoped to the source piece would be deleted
 * with it (FK cascade) under a live runner, and its failure lost.
 *   - 404 `{ error: "template_not_found" }`
 *   - 409 `{ error, code: "installed" }`: a catalog template keeps its author's example
 *   - 409 `{ error: SOURCE_PIECE_GONE, code: "source_piece_gone" }`
 *   - 409 `{ error: SOURCE_PIECE_EMPTY, code: "source_piece_empty" }`: the CURRENT piece has
 *     no overlays and no audio (TPL-3 Important-1) — checked live, since a piece non-empty
 *     when its template was made can be emptied afterwards; never enqueued, so it never fails
 *     a job with an error-level `jobs.run.failed` against the classifier's "nothing to export"
 *   - 500 `{ error: RENDER_START_FAILED }` when the job could not be started
 * A same-origin POST: the proxy's origin gate covers it.
 */
export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!isSafePieceId(id)) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
  const row = getTemplate(id);
  if (!row) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
  if (row.origin !== "local") return NextResponse.json({ error: INSTALLED_KEEPS_EXAMPLE, code: "installed" }, { status: 409 });
  const pieceId = row.createdFromPieceId;
  if (!sourcePieceExists(pieceId)) {
    return NextResponse.json({ error: SOURCE_PIECE_GONE, code: "source_piece_gone" }, { status: 409 });
  }
  if (await pieceHasNothingToExport(pieceId)) {
    return NextResponse.json({ error: SOURCE_PIECE_EMPTY, code: "source_piece_empty" }, { status: 409 });
  }
  const mgr = getJobManager();
  let enq: Awaited<ReturnType<typeof mgr.enqueue>>;
  try {
    enq = await mgr.enqueue("template_example", { templateId: id }, { forceNew: true });
  } catch (err) {
    logger.error(
      { tag: TEMPLATES_LOG_TAG, op: "example_request_failed", templateId: id, err: err instanceof Error ? err.message : String(err) },
      "template example render could not start",
    );
    return NextResponse.json({ error: RENDER_START_FAILED }, { status: 500 });
  }
  logger.info({ tag: TEMPLATES_LOG_TAG, op: "example_requested", templateId: id, status: enq.status }, "template example render requested");
  trackServerEvent("template_preview_requested");
  if (enq.status === "matching_completed") return NextResponse.json({ jobId: enq.existingJob.jobId }, { status: 202 });
  const jobId = enq.jobId;
  // Attaching to a render in flight runs nothing twice: runToCompletion joins its execution.
  void mgr.runToCompletion(jobId).catch((err) =>
    logger.warn(
      { tag: TEMPLATES_LOG_TAG, op: "example_render_failed", templateId: id, jobId, err: err instanceof Error ? err.message : String(err) },
      "template example render ended without an example",
    ),
  );
  return NextResponse.json({ jobId }, { status: 202 });
}
