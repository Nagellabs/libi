import { getJobManager } from "@/lib/jobs/manager";
import { serverLogger as logger } from "@/lib/logger";
import type { EnqueueResult } from "@/lib/jobs/types";

/**
 * Drive an already-enqueued `piece_dup` job to completion in the background.
 * Returns immediately — callers do NOT await.
 *
 * **Next.js process only.** The duplication REST routes
 * (`/api/pieces/[id]/duplicate`, `/api/folders/[id]/duplicate`) run in the
 * Next.js process and grab the in-process `JobManager` directly. `enqueue()`
 * alone only inserts the `jobs` row — without this the runner never starts
 * and the job sits `queued` forever.
 *
 * Mirrors `lib/proxy/enqueue.ts#enqueueProxyGen`: for fire-and-forget jobs the
 * enqueuer is responsible for kicking off `runToCompletion`. `POST /api/jobs`
 * does this for HTTP-client callers (the MCP tool path); these REST routes
 * bypass `/api/jobs` so they must drive it themselves.
 *
 * `matching_completed` carries no `jobId` (the prior run is reused) — nothing
 * to drive. `new` / `attached_running` schedule the runner.
 */
export function drivePieceDupJob(enq: EnqueueResult): void {
  if (enq.status === "matching_completed") return;
  const jobId = enq.jobId;
  void getJobManager()
    .runToCompletion(jobId)
    .catch((err) => {
      logger.warn(
        {
          tag: "duplication",
          op: "run_job_failed",
          jobId,
          err: err instanceof Error ? err.message : String(err),
        },
        "duplication.run.failed",
      );
    });
}
