import { getJobManager } from "@/lib/jobs/manager";
import { serverLogger as logger } from "@/lib/logger";

/** Idle keep-alive for the job SSE stream (see the note beside `detach`). */
const HEARTBEAT_MS = 25_000;

/** How many times to re-check a missing job before declaring it absent, and
 *  how long to wait between tries. Sized for the enqueue race (the row lands
 *  within milliseconds), not for a slow job. */
const NOT_FOUND_RETRIES = 3;
const NOT_FOUND_RETRY_MS = 500;

/** Server-Sent Events stream for live job progress. The chat UI / Settings UI
 *  can subscribe here and receive `progress`, `completed`, `failed`, and
 *  `cancelled` events. */
export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const mgr = getJobManager();

  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // Controller may have been closed by the client between the check
          // and the enqueue (race). Swallow.
        }
      };

      const onProgress = (p: { jobId: string }) => {
        if (p.jobId === id) send("progress", p);
      };
      const onCompleted = (p: { jobId: string }) => {
        if (p.jobId !== id) return;
        send("completed", p);
        finish();
      };
      const onFailed = (p: { jobId: string }) => {
        if (p.jobId !== id) return;
        send("failed", p);
        finish();
      };
      const onCancelled = (p: { jobId: string }) => {
        if (p.jobId !== id) return;
        send("cancelled", p);
        finish();
      };

      mgr.on("progress", onProgress);
      mgr.on("completed", onCompleted);
      mgr.on("failed", onFailed);
      mgr.on("cancelled", onCancelled);

      // Keep-alive. Progress on a long job can be SPARSE: the ACE-Step model
      // download reports once per file, and a single 3 GB safetensors takes
      // many minutes, so the stream goes completely silent in between. undici
      // (Node's fetch, which mcp/jobs-client.ts uses) kills a body that
      // produces nothing for its default timeout, and the agent's tool call
      // dies with an opaque `terminated` WHILE THE JOB IS STILL SUCCEEDING
      // server-side. Measured 2026-08-02 on the packaged app: two consecutive
      // `terminated` errors mid-download, after which the same job carried on
      // to completion — so the agent's only signal was a spurious failure, and
      // its natural response is to retry and re-download gigabytes.
      //
      // Same fix, same reason as `app/api/agent/events/route.ts` — that one was
      // repaired first and this sibling route was left behind, which is exactly
      // the "fixed one path, left the other" trap. SSE comments are ignored by
      // every conforming parser, so no consumer sees a spurious event.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          /* stream already closed */
        }
      }, HEARTBEAT_MS);

      const detach = () => {
        clearInterval(heartbeat);
        mgr.off("progress", onProgress);
        mgr.off("completed", onCompleted);
        mgr.off("failed", onFailed);
        mgr.off("cancelled", onCancelled);
      };

      const finish = () => {
        if (closed) return;
        closed = true;
        detach();
        try { controller.close(); } catch { /* already closed */ }
      };

      cleanup = () => {
        if (closed) return;
        closed = true;
        detach();
      };

      // Send the current snapshot once on open so the client doesn't have to
      // race a separate GET.
      //
      // Late-subscribe fix: if the job is ALREADY terminal when the client
      // subscribes, the manager won't fire any more events for this jobId
      // (it fired once when the job ended; we missed it). Without this, the
      // SSE stream would hang forever. So after sending the snapshot, inspect
      // its status and synthesize the corresponding terminal event + close.
      const openSnapshot = (attempt: number) => {
        mgr.getStatus(id).then((snap) => {
        send("snapshot", snap);
        if (snap.status === "completed") {
          // Shape parity with the live path: the manager emits
          // `{ jobId, result }` and `JSON.stringify` omits `result` when it's
          // `undefined`. Mirror that here — only include `result` when we have
          // a parseable stored value. Otherwise emit `{ jobId }` with no
          // `result` field. Downstream consumers (MCP HTTP client) rely on a
          // consistent shape across the live and synthesized paths.
          const payload: { jobId: string; result?: unknown } = { jobId: id };
          if (snap.resultJson) {
            try {
              payload.result = JSON.parse(snap.resultJson);
            } catch (err) {
              logger.warn(
                {
                  tag: "jobs",
                  op: "events_result_parse_failed",
                  jobId: id,
                  err: err instanceof Error ? err.message : String(err),
                },
                "Failed to parse stored resultJson for completed job",
              );
            }
          }
          send("completed", payload);
          finish();
        } else if (snap.status === "failed") {
          send("failed", { jobId: id, error: snap.error ?? "unknown" });
          finish();
        } else if (snap.status === "cancelled") {
          send("cancelled", { jobId: id });
          finish();
        }
        }).catch(() => {
          // A miss here is one of two things and they need opposite handling:
          //
          //   * the brand-new-enqueue race — the row is written a moment after
          //     the client subscribes. Retrying is correct.
          //   * the job genuinely does not exist — a stale id, or a row a
          //     `forceNew` superseded and deleted. Retrying forever is not:
          //     swallowing the error left the stream open with nothing but
          //     heartbeats, so `runJobViaServer` waited on a job that was never
          //     going to report, and the agent sat on a tool call indefinitely.
          //     The heartbeat added by this branch makes that hang PERMANENT
          //     rather than eventually timing out, which is why it has to be
          //     closed properly rather than left to undici.
          //
          // So: bounded retries for the race, then an honest terminal event.
          if (attempt < NOT_FOUND_RETRIES && !closed) {
            setTimeout(() => openSnapshot(attempt + 1), NOT_FOUND_RETRY_MS);
            return;
          }
          logger.warn(
            { tag: "jobs", op: "events_job_not_found", jobId: id },
            "closing job event stream — no such job",
          );
          send("failed", { jobId: id, error: `no such job: ${id}` });
          finish();
        });
      };
      openSnapshot(0);
    },
    cancel() {
      // Client disconnected.
      if (cleanup) cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
