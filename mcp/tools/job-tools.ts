/**
 * Generic background-job MCP tools — status polling + graceful cancellation.
 *
 * These are the agent-facing counterparts to `GET /api/jobs/[id]` and
 * `DELETE /api/jobs/[id]`. Anything backed by the JobManager (tracking,
 * proxy generation, exports, analysis, ...) is observable + cancellable
 * through these two tools, so callers don't need a per-kind status tool.
 *
 * The MCP child does NOT import `lib/jobs/manager`. Both tools call the
 * Next.js server over HTTP via `@/mcp/jobs-client`.
 */

import {
  cancelJobOnServer,
  getJobStatusFromServer,
  listJobsFromServer,
  LibiServerUnavailableError,
} from "@/mcp/jobs-client";
import type { ToolResult } from "./types";
import type {
  CancelJobParams,
  GetJobStatusParams,
  ListJobsParams,
} from "./schemas";

export async function getJobStatus(
  params: GetJobStatusParams,
): Promise<ToolResult> {
  try {
    const snap = await getJobStatusFromServer(params.jobId);
    return {
      success: true,
      data: snap as unknown as Record<string, unknown>,
    };
  } catch (err) {
    if (err instanceof LibiServerUnavailableError) {
      return {
        success: false,
        error: "libi_server_unavailable",
        data: { hint: err.hint },
      };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * How long a job has been running (or ran).
 *
 * `JobStatusSnapshot` types these as `Date`, but this module reads them back
 * over HTTP where `JSON.parse` yields ISO STRINGS — the client casts the
 * response to the snapshot type, so TypeScript never notices. Calling
 * `.valueOf()` on a string returns the string, and the subtraction would quietly
 * produce NaN. Normalise both shapes.
 */
function elapsedMs(
  startedAt: Date | string | null,
  completedAt: Date | string | null,
  now: number,
): number | null {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return null;
  const end = completedAt ? new Date(completedAt).getTime() : now;
  if (Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

/**
 * List jobs without needing an id. See `listJobsFromServer` for why this is not
 * redundant with `getJobStatus`.
 *
 * Returns a trimmed row rather than the raw snapshot: the agent needs to say
 * what is happening, not to reconstruct the DB. `resultJson` in particular is
 * omitted — it can be large, and every caller of THIS tool wants the shape of
 * the work, not its payload.
 */
export async function listJobs(params: ListJobsParams): Promise<ToolResult> {
  try {
    const rows = await listJobsFromServer({
      status: params.status,
      kind: params.kind,
      limit: params.limit ?? 20,
    });
    const now = Date.now();
    return {
      success: true,
      data: {
        count: rows.length,
        jobs: rows.map((j) => ({
          jobId: j.id,
          kind: j.kind,
          status: j.status,
          pieceId: j.pieceId,
          progress:
            j.progressTotal > 0
              ? `${j.progressDone}/${j.progressTotal} ${j.progressUnit}`
              : null,
          percent:
            j.progressTotal > 0
              ? Math.floor((j.progressDone / j.progressTotal) * 100)
              : null,
          etaMs: j.etaMs,
          // Present for a running job that has gone quiet. Distinguishes "still
          // working, just between ticks on a big file" from "wedged" — without
          // it the agent can only guess, and guessing is what produced the
          // wrong "nothing has been downloaded" answer.
          msSinceProgress: j.msSinceProgress,
          elapsedMs: elapsedMs(j.startedAt, j.completedAt, now),
          error: j.error,
        })),
      },
    };
  } catch (err) {
    if (err instanceof LibiServerUnavailableError) {
      return {
        success: false,
        error: "libi_server_unavailable",
        data: { hint: err.hint },
      };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function cancelJob(
  params: CancelJobParams,
): Promise<ToolResult> {
  try {
    await cancelJobOnServer(params.jobId);
    return { success: true, data: { jobId: params.jobId } };
  } catch (err) {
    if (err instanceof LibiServerUnavailableError) {
      return {
        success: false,
        error: "libi_server_unavailable",
        data: { hint: err.hint },
      };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
