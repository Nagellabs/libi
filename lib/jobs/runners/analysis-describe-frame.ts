import { z } from "zod/v3";
import type { JobContext, JobRunner } from "@/lib/jobs/types";
import { CancelledError } from "@/lib/jobs/types";

/**
 * Frame-description runner.
 *
 * STATUS — STUB. No callers today; stub for a future server-side LLM helper.
 * The kind + param schema are registered so callers can enqueue jobs and the
 * in-process concurrency cap (`maxConcurrent: 4`) becomes the rate-limit
 * primitive once a server-side LLM call lands. Today, frame descriptions are
 * produced by the ACP agent itself (vision LLM call via the `video-analysis`
 * skill) and persisted via the `libi.analysis_save_frames` MCP tool — there is
 * no server-side LLM helper for a single frame.
 *
 * To make this runner functional in a follow-up PR:
 *   1. Add an exported helper in `lib/analysis/manager.ts` (e.g.
 *      `describeFrameViaLlm({ fileId, frameIndex }) → Promise<void>`) that
 *      performs the vision LLM call and persists via the existing `saveFrames`
 *      path.
 *   2. Wire it in below where the TODO marker sits.
 *   3. Have `mcp/tools/analysis-tools.ts` (or a new tool) call
 *      `getJobManager().enqueue("analysis_describe_frame", { fileId, frameIndex })`
 *      and `runToCompletion`, replacing any agent-side LLM call sites that
 *      should run server-side.
 *
 * Granularity is per-frame (not per-batch) so cancellation cancels just one
 * frame, and the per-kind concurrency cap of 4 acts as the LLM API rate-limit.
 */

const analysisDescribeFrameParamsSchema = z.object({
  fileId: z.string().min(1),
  frameIndex: z.number().int().nonnegative(),
});

export type AnalysisDescribeFrameParams = z.infer<
  typeof analysisDescribeFrameParamsSchema
>;

export interface AnalysisDescribeFrameResult {
  frameIndex: number;
  ok: true;
}

export const analysisDescribeFrameRunner: JobRunner<
  AnalysisDescribeFrameParams,
  AnalysisDescribeFrameResult
> = {
  kind: "analysis_describe_frame",
  // LLM-bound; the concurrency cap doubles as a rate limit. Higher than CPU-bound
  // runners (proxy_gen=2) but well below what'd trip provider limits.
  maxConcurrent: 4,
  paramsSchema: analysisDescribeFrameParamsSchema,
  // A single LLM call has no clean midpoint — retry from scratch on failure.
  resumable: false,
  // LLM calls can stall on network hiccups; 60s no-progress watchdog is fine.
  noProgressTimeoutMs: 60_000,
  async run(
    ctx: JobContext<AnalysisDescribeFrameParams>,
  ): Promise<AnalysisDescribeFrameResult> {
    ctx.reportProgress(0, 1, "frames");
    if (ctx.shouldCancel()) throw new CancelledError(ctx.jobId);

    // TODO(analysis-jobs): once a server-side `describeFrameViaLlm` helper
    // exists in `lib/analysis/manager.ts`, call it here:
    //
    //   await describeFrameViaLlm({
    //     fileId: ctx.params.fileId,
    //     frameIndex: ctx.params.frameIndex,
    //   });
    //
    // For now the runner is a stub — it locks in the kind + param schema so
    // callers can be migrated incrementally.

    if (ctx.shouldCancel()) throw new CancelledError(ctx.jobId);
    ctx.reportProgress(1, 1, "frames");
    return { frameIndex: ctx.params.frameIndex, ok: true };
  },
};
