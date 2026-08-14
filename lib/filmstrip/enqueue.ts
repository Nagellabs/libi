import { getJobManager } from "@/lib/jobs/manager";
import { proxyLogger as logger } from "@/lib/logger";

export interface FilmstripEnqueueOptions {
  pieceId?: string | null;
  /** When true, ignore any existing matching job and start a fresh one. */
  regenerate?: boolean;
}

/**
 * Enqueue a `filmstrip_gen` job and drive it to completion in the background.
 * Returns immediately. Callers do NOT await. Mirrors `enqueueProxyGen`.
 *
 * **Next.js process only.** Grabs the in-process `JobManager` directly. Used
 * by the lazy filmstrip-status `?ensure=1` route. MCP-side callers would use
 * `enqueueJobOnServer("filmstrip_gen", ...)` — but filmstrip generation is
 * server-internal (no MCP tool), so there are none today.
 */
export function enqueueFilmstripGen(
  fileId: string,
  options: FilmstripEnqueueOptions = {},
): void {
  const mgr = getJobManager();
  void mgr
    .enqueue(
      "filmstrip_gen",
      { fileId },
      {
        pieceId: options.pieceId ?? undefined,
        fileId,
        forceNew: options.regenerate === true,
      },
    )
    .then((result) => {
      if (result.status === "matching_completed") return;
      return mgr.runToCompletion(result.jobId);
    })
    .catch((err) => {
      logger.warn(
        { fileId, err: err instanceof Error ? err.message : String(err) },
        "filmstrip.enqueue.failed",
      );
    });
}
