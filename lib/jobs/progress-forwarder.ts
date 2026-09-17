import type { JobManager } from "@/lib/jobs/manager";
import { serverLogger as logger } from "@/lib/logger";

interface ForwardOptions {
  mgr: JobManager;
  jobId: string;
  /** MCP progress token sent by the client in `_meta.progressToken`. If
   *  undefined, this is a no-op — clients that don't request progress
   *  shouldn't see notifications. */
  progressToken: string | number | undefined;
  /** The MCP SDK's `extra.sendNotification`. Async; we fire-and-forget. */
  sendNotification: (n: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      /** Omitted for an indeterminate job — see the note in the handler. */
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

/**
 * Subscribe to a JobManager's progress events for `jobId` and forward each
 * tick to the MCP client as a standard `notifications/progress` notification.
 * Returns an unsubscribe function — call it when the tool's job completes
 * (or in a finally) to avoid leaks.
 *
 * Why this matters: the chat UI's tool-call entry receives ACP
 * `tool_call_update` events which (when claude-agent-acp surfaces MCP
 * progress notifications) populate the `progress` text field on the right
 * `toolCallId`. No jobId↔toolCallId correlation needed on our side — the
 * MCP request/response context already carries the toolCallId on the agent.
 */
export function forwardJobProgressViaMcp(opts: ForwardOptions): () => void {
  const { mgr, jobId, progressToken, sendNotification } = opts;
  if (progressToken === undefined) {
    return () => {};
  }

  const handler = (p: { jobId: string; done: number; total: number; unit: string }) => {
    if (p.jobId !== jobId) return;
    // `total: 0` is how a job says "size unknown" (a yt-dlp stream with no
    // Content-Length, JobManager's own 0/0 baseline stamp). The MCP progress
    // notification represents that by OMITTING `total`, so the client renders
    // an indeterminate bar. Clamping it to 1 instead told the agent "43/1
    // bytes" and climbing, which it faithfully relayed to the user.
    const indeterminate = p.total <= 0;
    const message = indeterminate ? `${p.done} ${p.unit}` : `${p.done}/${p.total} ${p.unit}`;
    void sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: p.done,
        ...(indeterminate ? {} : { total: p.total }),
        message,
      },
    }).catch((err) => {
      logger.warn({ err, jobId }, "jobs.progress.notify_failed");
    });
  };

  mgr.on("progress", handler);
  return () => {
    mgr.off("progress", handler);
  };
}
