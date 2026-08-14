import { z } from "zod/v3";
import { navigationEmitter } from "@/lib/navigation-events";
import { clonePieceInto } from "@/lib/duplication/clone-piece";
import type { JobContext, JobRunner } from "@/lib/jobs/types";

const pieceDupParamsSchema = z.object({
  sourcePieceId: z.string().min(1),
  newPieceId: z.string().min(1),
  source: z.enum(["draft", "snapshot"]),
});

export type PieceDupParams = z.infer<typeof pieceDupParamsSchema>;

export interface PieceDupResult {
  sourcePieceId: string;
  newPieceId: string;
}

export const pieceDupRunner: JobRunner<PieceDupParams, PieceDupResult> = {
  kind: "piece_dup",
  maxConcurrent: 2,
  paramsSchema: pieceDupParamsSchema,
  resumable: false,
  // file copies can run for a while with no fine-grained ticks on big files
  noProgressTimeoutMs: null,
  async run(ctx: JobContext<PieceDupParams>): Promise<PieceDupResult> {
    const { sourcePieceId, newPieceId, source } = ctx.params;
    ctx.reportProgress(0, 1, "files");
    await clonePieceInto(sourcePieceId, newPieceId, source, (done, total) => {
      ctx.reportProgress(done, Math.max(total, 1), "files");
    });
    ctx.reportProgress(1, 1, "files");
    // Nudge clients: the copy now has real content / or the shell is gone on failure.
    navigationEmitter.emit("refresh_query", { queryKey: "pieces" });
    navigationEmitter.emit("refresh_query", { queryKey: "piece", pieceId: newPieceId });
    return { sourcePieceId, newPieceId };
  },
};
