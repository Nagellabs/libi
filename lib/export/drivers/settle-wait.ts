import { isRenderJobPending, RENDER_ABSOLUTE_CAP_MS } from "@/lib/export/render-jobs";

/**
 * Resolves once the registry entry for `jobId` settles (resolve/reject/
 * timeout), polling every `pollMs`, or after `capMs` as an absolute
 * backstop. Never rejects.
 */
export function waitForRenderJobSettlement(
  jobId: string,
  opts?: { pollMs?: number; capMs?: number },
): Promise<void> {
  const pollMs = opts?.pollMs ?? 2_000;
  const capMs = opts?.capMs ?? RENDER_ABSOLUTE_CAP_MS + 60_000;

  return new Promise<void>((resolve) => {
    // `done` closes over `interval`/`cap`, which are initialized below —
    // safe because timer callbacks never fire synchronously.
    const done = () => {
      clearInterval(interval);
      clearTimeout(cap);
      resolve();
    };
    // If the job already settled (or never existed), resolve on the next tick.
    const interval = setInterval(() => {
      if (!isRenderJobPending(jobId)) done();
    }, pollMs);
    const cap = setTimeout(done, capMs);
  });
}
