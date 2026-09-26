import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { getSocialSettings } from "@/lib/db/settings";
import { getJobManager } from "@/lib/jobs/manager";
import type { SocialUploadResult } from "@/lib/jobs/runners/social-upload";
import { exportFingerprint } from "@/lib/social/export-fingerprint";
import { isAllowedExportPath } from "@/lib/social/fit-check";
import { errShape } from "@/lib/social/errors";
import { socialRoute, jsonBody } from "@/lib/social/route-helpers";
import { serverLogger as logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const uploadBodySchema = z.object({ exportPath: z.string().min(1), pieceId: z.string().min(1) });

/**
 * Don't hand back a presigned URL that is about to die. Attaching the file is
 * what promotes it out of `temp/`, and that happens at SUBMIT time — minutes
 * after this route answers — so a URL with less than this left is treated as
 * spent and re-uploaded. Matches `use-upload-job.tsx`'s own margin.
 */
const EXPIRY_MARGIN_MS = 60_000;

function usable(result: unknown): result is SocialUploadResult {
  if (!result || typeof result !== "object") return false;
  const r = result as Partial<SocialUploadResult>;
  if (typeof r.publicUrl !== "string" || !r.publicUrl) return false;
  const expiry = typeof r.expiresAt === "string" ? Date.parse(r.expiresAt) : NaN;
  // An expiry libi cannot read is not an excuse to re-upload for ever: treat
  // an unparseable one as still good and let the provider be the judge.
  return Number.isNaN(expiry) || expiry > Date.now() + EXPIRY_MARGIN_MS;
}

/**
 * `POST /api/social/upload` — enqueue the `social-upload` job (presign at the
 * provider, then PUT the export's bytes with progress) and hand back a jobId
 * the client follows via `GET /api/jobs/:id/events`, the same way
 * `use-export-flow.ts` follows an export.
 *
 * **One upload per export, not per pass.** This used to enqueue with
 * `forceNew: true`, so every trip through the composer's Targets → Next
 * uploaded the file again: three distinct `media.zernio.com/temp/…` objects
 * for ONE 1.3 MB export in eight minutes, and Zernio exposes no delete-media
 * tool, so each one is permanent litter in the user's account (QA 2026-09-21,
 * finding 5). The job layer already dedupes by `(kind, paramsHash)` — this
 * route just stopped opting out of it, with the file's own fingerprint in the
 * params so a RE-EXPORT to the same path is correctly a different upload.
 *
 * A reused upload answers with its `result` inline: the job is already
 * terminal, so there is no stream left to follow and the client would
 * otherwise be waiting on events that will never come.
 */
export async function POST(req: Request): Promise<Response> {
  return socialRoute("upload", async () => {
    const b = await jsonBody(req, uploadBodySchema);
    if (!b.ok) return b.res;
    if (!isAllowedExportPath(b.data.exportPath)) {
      return NextResponse.json({ error: "validation", message: "that file is not one of your exports" }, { status: 422 });
    }
    const providerId = getSocialSettings().providerId;
    if (!providerId) return NextResponse.json({ error: "no_provider" }, { status: 409 });

    const params = {
      providerId,
      exportPath: b.data.exportPath,
      pieceId: b.data.pieceId,
      fileFingerprint: exportFingerprint(b.data.exportPath),
    };
    const mgr = getJobManager();
    const enq = await mgr.enqueue("social-upload", params, { pieceId: b.data.pieceId });

    if (enq.status === "matching_completed") {
      const prior = enq.existingJob;
      if (prior.status === "completed" && usable(prior.result)) {
        logger.info(
          { tag: "social", op: "upload.reused", jobId: prior.jobId, pieceId: b.data.pieceId },
          "reusing the completed upload for this export",
        );
        return NextResponse.json({ jobId: prior.jobId, reused: true, result: prior.result });
      }
      // A failed/cancelled run, or a presigned URL that has run out: the hash
      // still matches, so only a forced enqueue can replace it.
      const forced = await mgr.enqueue("social-upload", params, { pieceId: b.data.pieceId, forceNew: true });
      return run("jobId" in forced ? forced.jobId : forced.existingJob.jobId);
    }

    // Everything left carries a `jobId`: a fresh row, or the run already in
    // flight for this same file that this caller now attaches to.
    return run(enq.jobId);
  });
}

/** `enqueue()` only inserts the row — same fire-and-forget dispatch as
 *  `app/api/export/route.ts`; the SSE stream surfaces any failure. Attaching
 *  to a run already in flight is the same call: `runToCompletion` awaits the
 *  one execution rather than starting a second. */
function run(jobId: string): Response {
  const mgr = getJobManager();
  void mgr.runToCompletion(jobId).catch((err) => {
    logger.warn({ tag: "social", op: "upload.background_failed", jobId, ...errShape(err) }, "social upload job failed");
  });
  return NextResponse.json({ jobId });
}
