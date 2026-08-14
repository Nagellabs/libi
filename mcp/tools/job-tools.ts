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
  LibiServerUnavailableError,
} from "@/mcp/jobs-client";
import type { ToolResult } from "./types";
import type { CancelJobParams, GetJobStatusParams } from "./schemas";

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
