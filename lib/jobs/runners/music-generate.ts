import { z } from "zod/v3";
import { generateMusic, type GenerationResult } from "@/lib/music/generate";
import type { JobContext, JobRunner } from "@/lib/jobs/types";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";

// Deterministic params only (no toolCallId/sessionId) — paramsHash dedupe.
const paramsSchema = z.object({
  prompt: z.string().min(1).max(1000),
  lyrics: z.string().max(2000).optional(),
  durationSeconds: z.number().min(1).max(240),
  instrumental: z.boolean().optional(),
  seed: z.number().int().optional(),
});

export type MusicGenerateParams = z.infer<typeof paramsSchema>;
export type MusicGenerateResult = GenerationResult;

export const musicGenerateRunner: JobRunner<
  MusicGenerateParams,
  MusicGenerateResult
> = {
  kind: "music_generate",
  mcpToolId: makeMcpToolId("libi", "libi.generate_music"),
  maxConcurrent: 1,
  paramsSchema,
  // ACE-Step diffusion has no resumable midpoint.
  resumable: false,
  // CPU diffusion runs silently for minutes — disable the watchdog;
  // the timer-based PROGRESS lines still drive reportProgress.
  noProgressTimeoutMs: null,
  async run(ctx: JobContext<MusicGenerateParams>): Promise<MusicGenerateResult> {
    return generateMusic(
      {
        prompt: ctx.params.prompt,
        lyrics: ctx.params.lyrics,
        durationSeconds: ctx.params.durationSeconds,
        instrumental: ctx.params.instrumental,
        seed: ctx.params.seed,
      },
      (done, total) => ctx.reportProgress(done, total, "sec"),
      () => ctx.shouldCancel(),
    );
  },
};
