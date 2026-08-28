// app/api/agents/[agentId]/install/route.ts
//
// Drives the `agent_install` JobManager job (lib/jobs/runners/agent-install.ts)
// that installs Claude Code's ACP adapter — the browser-facing half of Stage 3.
//
// POST — enqueue. Mirrors POST /api/jobs: this route is the ONLY thing that
//        calls `runToCompletion`, so a job that reaches `new`/`attached_running`
//        without going through here never runs. Dedup while a job is live is
//        entirely JobManager's: two POSTs while one install is in flight
//        return `attached_running` with the SAME jobId, surfaced as-is. The
//        one guard this route adds on top: a `matching_completed` hit on a
//        `failed`/`cancelled` row is re-enqueued with `forceNew: true` so
//        Install/Retry actually starts a fresh attempt instead of replaying
//        a dead job's old status forever — same shape as
//        `enqueueRuntimeInstall()` in app/api/runtime/update/route.ts. A
//        `completed` match is left alone; re-running a finished ~345MB
//        install because someone double-clicked would be the opposite bug.
// GET  — status. `agent_install` jobs have no dedicated `agentId` column, so
//        "the job for this agent" means the newest `agent_install` row whose
//        stored params match — same technique as `latestInstallJob()` in
//        app/api/runtime/update/route.ts (kind-scoped read + parse
//        `paramsJson`), not a paramsHash lookup.
// DELETE — cancel. Resolves the same "newest job for this agent" and
//          delegates to `JobManager.cancel`, exactly like
//          `DELETE /api/jobs/[id]`.
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema/sqlite";
import { getJobManager } from "@/lib/jobs/manager";
import { getAgentSetup } from "@/lib/agents/setup/registry";
import { serverLogger as logger } from "@/lib/logger";
import { JobNotFoundError, snapshotFromRow, type JobStatusSnapshot } from "@/lib/jobs/types";

const LOG_TAG = "agent-install-route";
const JOB_KIND = "agent_install";

// Bound the `agent_install` scan below the same way GET /api/jobs caps its
// own read — this route can't use `.limit(1)` like the runtime-update
// sibling because it has to skip rows for OTHER agents, but "bounded" beats
// "every row of this kind, forever" on a path polled every 2s.
const MAX_SCAN_ROWS = 500;

interface RouteParams {
  params: Promise<{ agentId: string }>;
}

/** Newest `agent_install` job whose stored `params.agentId` matches, or null.
 *  Rows come back newest-first (`orderBy(desc(createdAt))`); the loop below
 *  returns on the first match, which is therefore the newest one. A
 *  malformed `paramsJson` row (should not happen — this route and the
 *  runner are the only writers) is skipped rather than thrown on, same
 *  defensive stance as `latestInstallJob()` in the runtime-update route. */
function latestInstallJob(agentId: string): JobStatusSnapshot | null {
  const db = getDb();
  const rows = db
    .select()
    .from(jobs)
    .where(eq(jobs.kind, JOB_KIND))
    .orderBy(desc(jobs.createdAt))
    .limit(MAX_SCAN_ROWS)
    .all();
  for (const row of rows) {
    try {
      const params = JSON.parse(row.paramsJson) as { agentId?: unknown };
      if (params.agentId === agentId) return snapshotFromRow(row);
    } catch {
      continue;
    }
  }
  return null;
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  const { agentId } = await params;
  return NextResponse.json({ job: latestInstallJob(agentId) });
}

export async function POST(_req: Request, { params }: RouteParams): Promise<Response> {
  const { agentId } = await params;

  // Codex (and any unknown id) has no install step — libi ships Codex's
  // engine, so there is nothing for `agent_install` to do. This is a CLIENT
  // mistake (the connect card should never have offered the button), not a
  // server fault, so it is a 400 — never let it reach the runner, which
  // throws on exactly this and would otherwise turn into a 500.
  const setup = getAgentSetup(agentId);
  if (!setup || !setup.install) {
    logger.warn(
      { tag: LOG_TAG, op: "post_no_install_step", agentId },
      "agent-install.post.no_install_step",
    );
    return NextResponse.json({ error: `${agentId} has no install step` }, { status: 400 });
  }

  const mgr = getJobManager();
  let result = await mgr.enqueue(JOB_KIND, { agentId });

  // A failed or cancelled terminal row is the dead end this feature exists
  // to remove: without forcing a fresh row here, a second Install click just
  // replays the OLD row's failed/cancelled status and nothing runs. A
  // `completed` match keeps returning as-is — see the header comment.
  if (
    result.status === "matching_completed" &&
    (result.existingJob.status === "failed" || result.existingJob.status === "cancelled")
  ) {
    result = await mgr.enqueue(JOB_KIND, { agentId }, { forceNew: true });
  }

  const jobId = result.status === "matching_completed" ? result.existingJob.jobId : result.jobId;

  // Only `new`/`attached_running` need a runner scheduled — a
  // `matching_completed` result is a prior terminal row's own answer
  // replayed, not something to re-run. Same rule POST /api/jobs follows.
  if (result.status === "new" || result.status === "attached_running") {
    void mgr.runToCompletion(jobId).catch((err) => {
      logger.warn(
        {
          tag: LOG_TAG,
          op: "post_background_failed",
          agentId,
          jobId,
          err: err instanceof Error ? err.message : String(err),
        },
        "agent-install.post.background_failed",
      );
    });
  }

  logger.info(
    { tag: LOG_TAG, op: "post_enqueued", agentId, jobId, status: result.status },
    "agent-install.post.enqueued",
  );
  return NextResponse.json({ jobId, status: result.status });
}

export async function DELETE(_req: Request, { params }: RouteParams): Promise<Response> {
  const { agentId } = await params;

  const job = latestInstallJob(agentId);
  if (!job) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const mgr = getJobManager();
  try {
    await mgr.cancel(job.id);
    return NextResponse.json({ accepted: true });
  } catch (err) {
    if (err instanceof JobNotFoundError) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 },
    );
  }
}
