import type { EnqueueResult } from "@/lib/jobs/types";

/** Test helper: narrow an EnqueueResult and assert it produced a fresh
 *  jobId (i.e. status `new` or `attached_running`). Throws if the result is
 *  `matching_completed` (which has no `jobId` at the top level). */
export function jobIdOf(result: EnqueueResult): string {
  if (result.status === "matching_completed") {
    throw new Error(
      `expected new/attached_running enqueue result, got matching_completed (existing job ${result.existingJob.jobId})`,
    );
  }
  return result.jobId;
}

/** Test helper: returns true when the enqueue attached to an existing
 *  in-flight or terminal job. Mirrors the old `resumed: boolean` field. */
export function isResumed(result: EnqueueResult): boolean {
  return result.status === "attached_running" || result.status === "matching_completed";
}
