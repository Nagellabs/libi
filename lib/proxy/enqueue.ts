import { getJobManager } from "@/lib/jobs/manager";
import { proxyLogger as logger } from "@/lib/logger";

export interface ProxyEnqueueOptions {
  pieceId?: string | null;
  /** When true, ignore any existing matching job and start a fresh one. */
  regenerate?: boolean;
}

/**
 * Enqueue a `proxy_gen` job and drive it to completion in the background.
 * Returns immediately. Callers do NOT await.
 *
 * **Next.js process only.** This helper directly grabs the in-process
 * `JobManager` and runs the proxy_gen runner locally. It's used by the
 * Next.js startup sweep (`instrumentation.ts`) and the rename route
 * (`app/api/files/by-id/[fileId]/rename/route.ts`).
 *
 * MCP-side callers (upload tool, regenerate_proxy tool) MUST use
 * `enqueueJobOnServer("proxy_gen", { fileId }, ...)` from
 * `@/mcp/jobs-client` instead. The runner registry is process-local
 * and intentionally does NOT exist in the MCP stdio child.
 */
export function enqueueProxyGen(
  fileId: string,
  options: ProxyEnqueueOptions = {},
): void {
  const mgr = getJobManager();
  void mgr
    .enqueue(
      "proxy_gen",
      { fileId },
      {
        pieceId: options.pieceId ?? undefined,
        fileId,
        forceNew: options.regenerate === true,
      },
    )
    .then((result) => {
      // `matching_completed` means a prior proxy-gen for this fileId already
      // finished — no need to spawn another runner. `attached_running` lets
      // us await the in-flight one (idempotent). `new` / `new+forced` always
      // run a fresh runner.
      if (result.status === "matching_completed") return;
      return mgr.runToCompletion(result.jobId);
    })
    .catch((err) => {
      logger.warn(
        { fileId, err: err instanceof Error ? err.message : String(err) },
        "proxy.enqueue.failed",
      );
    });
}
