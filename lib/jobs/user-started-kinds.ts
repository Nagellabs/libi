/**
 * Job kinds only the USER starts, from libi's own UI — today
 * `template_publish`, started by the Templates page's confirm of a publish
 * request (lib/templates/cloud/publish-confirm.ts). `POST /api/jobs` never
 * starts one, from any caller, and `/api/jobs/:id/retry` never re-runs one
 * from stored params: every publish is a fresh confirm on the review panel.
 *
 * Its own module, free of Node imports, so Settings → Jobs can read it and
 * offer no Retry the route would only refuse.
 */
export const USER_STARTED_JOB_KINDS: ReadonlySet<string> = new Set(["template_publish"]);
