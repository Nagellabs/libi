/**
 * The user's "Publish publicly" on a publish request: the one way a
 * `template_publish` job starts (`POST /api/jobs` refuses the kind).
 *
 * The route (app/api/templates/cloud/publish-requests/[id]/confirm) runs the
 * browser-only checks first; this does the rest, in order:
 *   1. the request exists for this catalog and is awaiting (or failed);
 *   2. the confirm code the review panel was handed matches;
 *   3. the template, and the example and poster the request prepared, are
 *      still exactly what was reviewed (its fingerprint);
 *   4. the request is CLAIMED — status and code change in one statement, so a
 *      second confirm with the same code starts nothing;
 *   5. the job is enqueued in-process through the JobManager and run; its end
 *      settles the request (gone once published, `failed` otherwise).
 *
 * Server-only: imports lib/jobs, so nothing under mcp/ may import it.
 */
import { trackServerEvent } from "@/lib/analytics/server";
import { getJobManager } from "@/lib/jobs/manager";
import { serverLogger as logger } from "@/lib/logger";
import { navigationEmitter } from "@/lib/navigation-events";
import { CHANGED_SINCE_REVIEW } from "@/lib/templates/cloud/publish-content";
import {
  attachPublishJob,
  claimPublishRequest,
  confirmCodeMatches,
  currentRequestState,
  failPublishRequest,
  getPublishRequest,
  PUBLISHING_NOW,
  settlePublishRequest,
} from "@/lib/templates/cloud/publish-requests";
import { publishingTemplateIds } from "@/lib/templates/store";

const TAG = "templates-cloud";

/**
 * A confirm code that isn't the request's current one. Only a claim rotates
 * the code (a re-prepare makes a new request, and the old id is a 404), so the
 * usual sender is the page itself: another tab still showing the review from
 * before a publish there failed.
 */
export const STALE_CONFIRM_CODE =
  "This review is out of date — it was confirmed somewhere else, such as another tab. Look at it again here, and publish if it's still right.";
/** No code at all: not the review panel's click. */
export const NO_CONFIRM_CODE = "This confirm didn't come from the review on the Templates page. Open Templates and click Publish there.";

export type ConfirmOutcome =
  | { ok: true; jobId: string }
  | { ok: false; status: 403 | 404 | 409 | 500; code: "not_found" | "bad_confirm_code" | "publishing" | "changed" | "unavailable" | "start_failed"; error: string };

function refreshTemplates(): void {
  navigationEmitter.emit("refresh_query", { queryKey: "templates" });
}

export async function confirmPublishRequest(id: string, confirmCode: unknown): Promise<ConfirmOutcome> {
  const row = getPublishRequest(id);
  if (!row) return { ok: false, status: 404, code: "not_found", error: "That publish request is gone. Ask the agent to prepare the publish again." };
  if (row.status === "publishing") return { ok: false, status: 409, code: "publishing", error: PUBLISHING_NOW };
  if (!confirmCodeMatches(row, confirmCode)) {
    // A code that was the panel's once (the page refetches on settle and shows
    // the current review) is told so; a missing one is not the page's click.
    const sentOne = typeof confirmCode === "string" && confirmCode.length > 0;
    logger.warn({ tag: TAG, op: "publish_confirm_refused", requestId: id, code: "bad_confirm_code", sentCode: sentOne }, "confirm without the review panel's current code");
    return { ok: false, status: 403, code: "bad_confirm_code", error: sentOne ? STALE_CONFIRM_CODE : NO_CONFIRM_CODE };
  }
  let fingerprint: string;
  try {
    fingerprint = (await currentRequestState(row)).fingerprint;
  } catch (err) {
    return { ok: false, status: 409, code: "unavailable", error: err instanceof Error ? err.message : String(err) };
  }
  if (fingerprint !== row.fingerprint) {
    logger.info({ tag: TAG, op: "publish_confirm_refused", requestId: id, templateId: row.templateId, code: "changed" }, "template changed since it was prepared");
    return { ok: false, status: 409, code: "changed", error: CHANGED_SINCE_REVIEW };
  }
  if (publishingTemplateIds().has(row.templateId)) return { ok: false, status: 409, code: "publishing", error: PUBLISHING_NOW };
  if (!claimPublishRequest(id, row.confirmCode)) {
    return { ok: false, status: 409, code: "publishing", error: "This publish was already confirmed." };
  }

  const params = { templateId: row.templateId, requestId: row.id, ...(row.nickname ? { nickname: row.nickname } : {}), reviewedFingerprint: row.fingerprint };
  const mgr = getJobManager();
  let jobId: string;
  try {
    // forceNew: a publish is never answered from an earlier run's cached row —
    // each confirm is the user's fresh go-ahead, and the job itself resumes any
    // publish still pending on the template.
    const enq = await mgr.enqueue("template_publish", params, { forceNew: true });
    // forceNew never answers from a finished row; a run in flight is refused above.
    if (enq.status === "matching_completed") throw new Error("the job manager answered from an earlier publish");
    jobId = enq.jobId;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    failPublishRequest(id, `The publish didn't start: ${error}`);
    logger.error({ tag: TAG, op: "publish_confirm_start_failed", requestId: id, templateId: row.templateId, err: error }, "could not start the confirmed publish");
    refreshTemplates();
    return { ok: false, status: 500, code: "start_failed", error: "The publish didn't start. Try again." };
  }
  attachPublishJob(id, jobId);
  trackServerEvent("template_publish_confirmed");
  logger.info({ tag: TAG, op: "publish_confirmed", requestId: id, templateId: row.templateId, jobId }, "user confirmed a publish");
  const settle = () => {
    settlePublishRequest(id);
    refreshTemplates();
  };
  void mgr.runToCompletion(jobId).then(settle, (err: unknown) => {
    logger.warn({ tag: TAG, op: "publish_confirm_job_failed", requestId: id, jobId, err: err instanceof Error ? err.message : String(err) }, "confirmed publish did not publish");
    settle();
  });
  refreshTemplates();
  return { ok: true, jobId };
}
