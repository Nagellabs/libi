import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { z, ZodError } from "zod/v3";
import { getDb } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema/sqlite";
import { getJobManager } from "@/lib/jobs/manager";
import { checkPaidJobRateLimit } from "@/lib/jobs/rate-limit";
import { serverLogger as logger } from "@/lib/logger";
import {
  snapshotFromRow,
  type EnqueueResult,
  type JobStatusSnapshot,
} from "@/lib/jobs/types";

/** List recent jobs with optional `kind` / `status` filtering.
 *  Used by the Settings → Background Jobs tab. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const kindFilter = url.searchParams.get("kind");
  const statusFilter = url.searchParams.get("status");
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") ?? "100", 10) || 100,
    500,
  );

  const db = getDb();
  let rows = db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(limit).all();

  if (kindFilter) rows = rows.filter((r) => r.kind === kindFilter);
  if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);

  // NOT `rows.map(snapshotFromRow)` — map would pass the element index as the
  // second argument. See the note on snapshotFromRow.
  const snapshots: JobStatusSnapshot[] = rows.map((r) => snapshotFromRow(r));
  return NextResponse.json({ jobs: snapshots });
}

const postBodySchema = z.object({
  kind: z.string().min(1),
  params: z.unknown(),
  pieceId: z.string().nullish(),
  fileId: z.string().nullish(),
  /** Stable identifier the caller can use to correlate with later /api/jobs
   *  queries; echoed back in the response when a job is created or attached. */
  clientKey: z.string().optional(),
  /** Skip the paramsHash match check; delete any matching row and create a
   *  fresh one. */
  forceNew: z.boolean().optional(),
  /** Explicit discard-on-disk-output request. Never set by a retry path. */
  discardOutput: z.boolean().optional(),
  /** @deprecated — accepted as inverse of forceNew for backward compat. */
  resume: z.boolean().optional(),
  /** Tool identity/args hint forwarded from the MCP child. Attached to the
   *  JobManager BEFORE `runToCompletion` starts so the first progress tick
   *  already carries the identity the session bridge matches on. */
  toolHint: z
    .object({
      toolName: z.string(),
      toolArgs: z.unknown(),
      progressLabel: z.string().optional(),
    })
    .optional(),
});

/** Enqueue a new job and kick off execution in the background. The MCP
 *  stdio child posts here instead of importing JobManager directly. */
export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    logger.warn(
      { tag: "jobs", op: "post_bad_request", reason: "invalid_json" },
      "jobs.post.bad_request",
    );
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = postBodySchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn(
      { tag: "jobs", op: "post_bad_request", issues: parsed.error.issues },
      "jobs.post.bad_request",
    );
    return NextResponse.json(
      { error: "invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { kind, params, pieceId, fileId, clientKey, forceNew, discardOutput, resume, toolHint } =
    parsed.data;

  // Resolve the job manager FIRST — this registers the builtin runners on a
  // cold process. The paid-kind rate check below derives "paid" from the
  // registered runner's `paid` flag (isPaidJobKind → getRunner), so the
  // registry MUST be populated before it runs; otherwise the first paid
  // enqueue on a fresh process reads an empty registry and fails open past the
  // limiter. getJobManager() is idempotent and does not enqueue, so a
  // subsequently rate-limited request still returns 429 before any work.
  const mgr = getJobManager();

  // RC-E: bound provider billing. Cost-bearing kinds are rate-limited so a
  // same-origin runaway (or any residual path past the CSRF guard) can't rack
  // up unbounded spend. Non-paid/local kinds bypass this entirely.
  const rateDecision = checkPaidJobRateLimit(kind);
  if (!rateDecision.allowed) {
    logger.warn(
      {
        tag: "security",
        op: "paid_job_rate_limited",
        kind,
        retryAfterMs: rateDecision.retryAfterMs,
      },
      "jobs.post.rate_limited",
    );
    return NextResponse.json(
      { error: "rate_limited", retryAfterMs: rateDecision.retryAfterMs },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil(rateDecision.retryAfterMs / 1000)),
        },
      },
    );
  }

  let result: EnqueueResult;
  try {
    result = await mgr.enqueue(kind, params, {
      pieceId: pieceId ?? null,
      fileId: fileId ?? null,
      clientKey,
      forceNew,
      discardOutput,
      resume,
    });
  } catch (err) {
    if (err instanceof ZodError) {
      logger.warn(
        { tag: "jobs", op: "post_bad_request", kind, issues: err.issues },
        "jobs.post.invalid_params",
      );
      return NextResponse.json(
        { error: "invalid params", issues: err.issues },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("No runner registered for kind:")) {
      logger.warn(
        { tag: "jobs", op: "post_bad_request", kind, err: message },
        "jobs.post.enqueue_failed",
      );
      return NextResponse.json({ error: message }, { status: 400 });
    }
    logger.error(
      { tag: "jobs", op: "post_internal_error", kind, err: message },
      "jobs.post.internal_error",
    );
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }

  // Attach the tool hint BEFORE `runToCompletion` so the first progress tick
  // already carries the identity the session bridge matches on.
  if (toolHint && result.status !== "matching_completed") {
    mgr.attachToolHint(result.jobId, {
      toolName: toolHint.toolName,
      toolArgs: toolHint.toolArgs,
      ...(toolHint.progressLabel ? { progressLabel: toolHint.progressLabel } : {}),
    });
  }

  // Only schedule the runner for `new` or `attached_running`.
  // `matching_completed` re-uses the prior terminal result; spawning would
  // both be redundant and (for `failed`/`cancelled` rows) actively wrong.
  if (result.status === "new" || result.status === "attached_running") {
    const jobIdForLog = result.jobId;
    void mgr.runToCompletion(jobIdForLog).catch((err) => {
      logger.warn(
        {
          tag: "jobs",
          op: "post_background_failed",
          jobId: jobIdForLog,
          err: err instanceof Error ? err.message : String(err),
        },
        "jobs.post.background_failed",
      );
    });
  }

  logger.info(
    { tag: "jobs", op: "post_enqueued", status: result.status, kind },
    "jobs.post.enqueued",
  );
  return NextResponse.json(result);
}
