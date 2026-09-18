/**
 * Export MCP tools — let the agent trigger a piece export from chat.
 *
 * The tool delegates to the unified `export` JobManager runner via the
 * Next.js HTTP API:
 *   1. POST /api/export  → returns { jobId }
 *   2. Open SSE on /api/jobs/<id>/events to forward progress notifications
 *      to the chat UI as ACP `tool_call_update` events.
 *
 * Cancellation comes from the chat's existing Stop button (sends a job
 * cancel on the underlying jobId).
 */
import { getCurrentPort } from "@/lib/libi-home";
import { LibiServerUnavailableError } from "@/mcp/jobs-client";
import { mcpLogger as logger } from "@/lib/logger";
import { reportToolProgress } from "./tool-progress";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol";
import type {
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types";

export interface ExportVideoParams {
  pieceId: string;
  source?: "draft" | "snapshot";
  filename?: string;
  format?: "mp4" | "webm";
  quality?: "source" | "1080p" | "1440p" | "4k" | "custom";
  graphicsQuality?: "1080p" | "1440p" | "4k";
  customWidth?: number;
  customHeight?: number;
  destFolder?: string;
}

export interface ExportVideoResult {
  filePath: string;
  sizeBytes: number;
  durationSeconds: number;
  backend: string;
  width: number;
  height: number;
  /** Echoed back so the agent can show progress / cancellation references. */
  jobId: string;
  /** True when this export began by downloading Chromium (first canvas
   *  export on this machine) — so the agent can explain the extra time. */
  chromiumDownloaded?: boolean;
  /** Overlays whose draw threw during a chromium-render export and were
   *  skipped (QA 2026-09-18 B1 — e.g. a code overlay with no/invalid body).
   *  The export still succeeded; tell the user which overlay was dropped and
   *  why, and offer to fix its draw function. Absent when nothing was
   *  dropped. */
  droppedOverlays?: Array<{ id: string; message: string }>;
  /** Uploaded fonts a chromium-render export could not load (Final QA F1):
   *  their text rendered in a fallback face. The export still succeeded; tell
   *  the user which font and why. Absent when every font loaded. */
  unloadedFonts?: Array<{ fontFileId: string; family: string; reason: string }>;
}

interface ExportEnqueueResp {
  jobId: string;
  destFolder: string;
  filename: string;
  /** Set by the route when Chromium is absent: the approximate size of the
   *  download this export may start with. Null once it is installed. */
  chromiumDownloadMb?: number | null;
  settings: {
    format: "mp4" | "webm";
    width: number;
    height: number;
    bitrate: number;
    quality: string;
    graphicsQuality?: string;
  };
}

/**
 * Triggers an export via the unified `export` JobManager runner. Two-phase:
 * the route enqueues the job (returning the runner-resolved settings +
 * jobId), then we attach to it via SSE through `runJobViaServer` so
 * progress notifications flow to the chat UI on the original toolCallId.
 */
export async function exportVideo(
  params: ExportVideoParams,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<
  | { success: true; data: ExportVideoResult }
  | {
      success: false;
      error?: string;
      data?: { error: string; hint?: string };
    }
> {
  let port: number;
  try {
    port = getCurrentPort();
  } catch (err) {
    return {
      success: false,
      data: {
        error: "libi_server_unavailable",
        hint: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // First: POST the export request so the server validates + enqueues. We
  // don't use runJobViaServer's own enqueue path because the server route
  // resolves the quality preset → concrete settings — duplicating that
  // logic on the MCP side is brittle.
  let enq: ExportEnqueueResp;
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!resp.ok) {
      const body = await resp.text();
      return {
        success: false,
        data: { error: `export_enqueue_failed_${resp.status}`, hint: body },
      };
    }
    enq = (await resp.json()) as ExportEnqueueResp;
  } catch (err) {
    if (err instanceof LibiServerUnavailableError) {
      return {
        success: false,
        data: { error: "libi_server_unavailable", hint: err.hint },
      };
    }
    return {
      success: false,
      data: {
        error: "export_enqueue_failed",
        hint: err instanceof Error ? err.message : String(err),
      },
    };
  }

  logger.info(
    {
      tag: "export-tool",
      op: "enqueued",
      jobId: enq.jobId,
      pieceId: params.pieceId,
    },
    "export_video: job enqueued, waiting for completion",
  );

  // Disclose the cost BEFORE the wait begins. `waitForJobCompletion` blocks
  // until the job ends, so anything said afterwards is said too late.
  // Also rides the job_progress side channel so Claude's chat row shows it.
  if (enq.chromiumDownloadMb) {
    await reportToolProgress(extra, {
      progress: 0,
      total: enq.chromiumDownloadMb,
      message: `first canvas export downloads Chromium, ~${enq.chromiumDownloadMb} MB`,
    });
  }

  // Now attach to the running job so we forward progress. We don't re-enqueue
  // (forceNew would create a second job); instead we use runJobViaServer's
  // attach path by sending the same params again with `attachIfExists` — but
  // the simpler approach: just open the SSE stream ourselves and forward.
  //
  // For now: re-call runJobViaServer with `attachToJobId` is not available;
  // we POST a tracking-only attach via the existing SSE path on the jobId.
  // The jobs-client's `runJobViaServer` requires kind+params; instead we
  // open the events stream directly here.
  const result = await waitForJobCompletion(port, enq.jobId, extra);
  if (!result.ok) {
    return {
      success: false,
      data: { error: result.error, hint: result.hint },
    };
  }

  return {
    success: true,
    data: {
      ...result.value,
      jobId: enq.jobId,
      chromiumDownloaded: Boolean(enq.chromiumDownloadMb),
    },
  };
}

async function waitForJobCompletion(
  port: number,
  jobId: string,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<
  | { ok: true; value: Omit<ExportVideoResult, "jobId"> }
  | { ok: false; error: string; hint?: string }
> {
  // Use the progress-token from the MCP extra if present so claude-agent-acp
  // routes notifications to the same toolCallId.
  const progressToken = extra?._meta?.progressToken as string | number | undefined;

  let resp: Response;
  try {
    resp = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/events`, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
    });
  } catch (err) {
    return {
      ok: false,
      error: "export_stream_failed",
      hint: err instanceof Error ? err.message : String(err),
    };
  }
  if (!resp.ok || !resp.body) {
    return { ok: false, error: `export_stream_${resp.status}` };
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n\n");
      while (nl !== -1) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        nl = buf.indexOf("\n\n");
        if (!frame.trim()) continue;
        // Parse "event: <type>\ndata: <json>" SSE blocks.
        let eventType = "message";
        let dataLine = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
        }
        if (!dataLine) continue;
        let payload: { jobId?: string; done?: number; total?: number; unit?: string; result?: unknown; error?: string };
        try {
          payload = JSON.parse(dataLine);
        } catch {
          continue;
        }
        if (eventType === "progress" && progressToken !== undefined && extra?.sendNotification) {
          const done = typeof payload.done === "number" ? payload.done : 0;
          const total = typeof payload.total === "number" && payload.total > 0 ? payload.total : 1;
          const unit = payload.unit ?? "";
          await extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: done,
              total,
              message: unit ? `${done}/${total} ${unit}` : `${done}/${total}`,
            },
          }).catch(() => { /* ignore */ });
          continue;
        }
        if (eventType === "completed") {
          const r = payload.result as Omit<ExportVideoResult, "jobId"> | undefined;
          if (!r) {
            return { ok: false, error: "export_completed_without_result" };
          }
          return { ok: true, value: r };
        }
        if (eventType === "failed") {
          return { ok: false, error: "export_failed", hint: payload.error };
        }
        if (eventType === "cancelled") {
          return { ok: false, error: "export_cancelled" };
        }
      }
    }
    return { ok: false, error: "export_stream_ended_without_result" };
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
}
