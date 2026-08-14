import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExportBackend, ExportContext } from "@/lib/export/backend";
import type { ExportResult } from "@/lib/engine/types";
import { getJobManager } from "@/lib/jobs/manager";
import type { ExportRenderResult } from "@/lib/jobs/runners/export-render";
import { exportLogger } from "@/lib/logger";

export class ChromiumRenderBackend implements ExportBackend {
  readonly name = "chromium-render" as const;

  async run(ctx: ExportContext & { pieceId: string }): Promise<ExportResult> {
    if (!ctx.payload) {
      throw new Error("ChromiumRenderBackend requires ctx.payload (render data for the hidden window)");
    }

    // Delegate the full driver + render-page postback dance to the
    // `export_render` runner under JobManager. The runner still uses the
    // `render-jobs.ts` registry as the in-process page→server callback bus
    // (the render page POSTs back to `/api/export/render-result`); JobManager
    // owns the job lifecycle (queue, dedupe, cancel, status).
    const mgr = getJobManager();
    const enqueueResult = await mgr.enqueue(
      "export_render",
      {
        pieceId: ctx.pieceId,
        payload: ctx.payload,
        settings: ctx.settings,
      },
      // Force a fresh run for every export — re-using a completed export job
      // for a "new" export would skip the actual Chromium render.
      { forceNew: true, pieceId: ctx.pieceId },
    );
    // `forceNew: true` always returns a `new` (forced) shape; narrow for TS.
    if (enqueueResult.status !== "new") {
      throw new Error(
        `unexpected enqueue result for forced export render: ${enqueueResult.status}`,
      );
    }
    const jobId = enqueueResult.jobId;

    exportLogger.info(
      { event: "render_enqueue", jobId, pieceId: ctx.pieceId },
      "export.render_enqueue",
    );

    // If the caller's signal aborts, propagate cancel into JobManager.
    const onAbort = () => {
      mgr.cancel(jobId).catch((err: unknown) => {
        exportLogger.warn(
          { err, jobId },
          "export.render.cancel_failed",
        );
      });
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    let result: ExportRenderResult;
    try {
      // Forward the inner export_render job's per-frame progress out to the
      // caller (the `export` dispatcher runner), which re-reports it on the
      // 0..100 "%" scale the client's SSE stream consumes. Without this the
      // multi-scene / canvas export only emits 0% then 100% — the bar never
      // moves between. The inner job reports unit "frames" (total = frame
      // count) between the initial/final unit-"render" stamps (total 1), so
      // drive the ratio purely off the frame ticks.
      result = await mgr.runToCompletion<ExportRenderResult>(jobId, (p) => {
        if (p.unit === "frames" && p.total > 1) {
          ctx.onProgress?.(Math.max(0, Math.min(1, p.done / p.total)));
        }
      });
    } finally {
      ctx.signal?.removeEventListener("abort", onAbort);
    }

    const { tempFilePath, durationSeconds } = result;
    try {
      const bytes = await readFile(tempFilePath);
      const blob = new Blob([new Uint8Array(bytes)], {
        type: ctx.settings.format === "webm" ? "video/webm" : "video/mp4",
      });
      return {
        blob,
        duration: durationSeconds,
        format: ctx.settings.format,
      };
    } finally {
      await rm(dirname(tempFilePath), { recursive: true, force: true }).catch(() => {});
    }
  }
}
