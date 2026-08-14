/**
 * Server-side tracking runner endpoint.
 *
 * The MCP tool (`mcp/tools/tracking-tools.ts:computeObjectTrack`) runs in
 * a separate stdio process. The actual Playwright + MediaPipe pipeline
 * needs to run in the Next.js server process — both because the
 * Chromium-side page fetches the job payload from `/api/tracks/job/...`
 * (which lives here), and because the JobManager + job registry must be
 * in the same process as those routes.
 *
 * Post-T14: this endpoint emits the same {@link EnqueueResult} discriminated
 * union as `POST /api/jobs`, with two enrichments:
 *   - `new` / `attached_running` shapes are awaited via `runToCompletion`
 *     and the runner's `result` is merged into the response under
 *     `result: { samples, framerate }`.
 *   - `matching_completed` returns directly without spawning another run;
 *     `existingJob.result` already holds the cached `{ samples, framerate }`.
 */
import { NextResponse } from "next/server";
import { getJobManager } from "@/lib/jobs/manager";
import { serverLogger as logger } from "@/lib/logger";
import { getCurrentPort } from "@/lib/libi-home";
import { assertLoopbackOrPublicHttpUrl } from "@/lib/net/url-guard";
import type { Anchor, TrackSample } from "@/lib/tracking/types";

export async function POST(req: Request) {
  let body: {
    pieceId?: string;
    fileId?: string;
    fileUrl?: string;
    fps?: number;
    objectKind?: "face" | "object";
    anchors?: Anchor[];
    resume?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const { pieceId, fileId, fileUrl, fps, objectKind, anchors, resume } = body;
  if (
    !pieceId ||
    !fileId ||
    !fileUrl ||
    typeof fps !== "number" ||
    !objectKind ||
    !Array.isArray(anchors) ||
    anchors.length < 1 ||
    anchors.length > 5
  ) {
    return NextResponse.json(
      { error: "missing required fields (anchors[] with 1..5 entries required)" },
      { status: 400 },
    );
  }

  // SSRF guard: `fileUrl` is caller-supplied. The one legitimate non-public
  // shape is a loopback url on THIS app's own port (the internal caller in
  // lib/tracking/recompute-segment.ts builds exactly that); anything else
  // must resolve to a public address. Reject BEFORE enqueueing so a bad
  // fileUrl never reaches the job runner's fetch.
  try {
    await assertLoopbackOrPublicHttpUrl(fileUrl, getCurrentPort());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `invalid fileUrl: ${message}` }, { status: 400 });
  }

  const mgr = getJobManager();
  try {
    const enqueueResult = await mgr.enqueue(
      "tracking",
      { fileId, pieceId, fileUrl, fps, objectKind, anchors },
      // Legacy `resume` semantics: `resume: false` ⇒ forceNew.
      { forceNew: resume === false, pieceId, fileId },
    );

    // matching_completed: cached terminal row already holds the result —
    // return the EnqueueResult shape as-is.
    if (enqueueResult.status === "matching_completed") {
      return NextResponse.json(enqueueResult);
    }

    // new / attached_running / new+forced: drive to completion and merge
    // the runner result into the union shape.
    const result = await mgr.runToCompletion<{
      samples: TrackSample[];
      framerate: number;
    }>(enqueueResult.jobId);
    return NextResponse.json({ ...enqueueResult, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "tracking.run.error");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
