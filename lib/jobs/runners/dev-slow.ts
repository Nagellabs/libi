/**
 * Deterministic slow job for chat-UI verification (spec 2026-07-04, section
 * E): "call libi.dev_slow_job for 60s and libi.list_pieces in parallel"
 * reproduces the fast+slow scenario; two dev_slow_job calls with different
 * seconds reproduce same-name concurrency (correlation, two stop buttons,
 * two ETAs). The tool is registered only outside production builds.
 */
import { z } from "zod/v3";
import type { JobRunner, JobContext } from "@/lib/jobs/types";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";

const paramsSchema = z.object({
  seconds: z.number().int().min(1).max(600),
  label: z.string().optional(),
});

export type DevSlowParams = z.infer<typeof paramsSchema>;
export interface DevSlowResult {
  ticks: number;
  label?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const devSlowRunner: JobRunner<DevSlowParams, DevSlowResult> = {
  kind: "dev_slow",
  maxConcurrent: 4,
  resumable: false,
  paramsSchema: paramsSchema as unknown as z.ZodSchema<DevSlowParams>,
  mcpToolId: makeMcpToolId("libi", "libi.dev_slow_job"),

  async run(ctx: JobContext<DevSlowParams>): Promise<DevSlowResult> {
    const { seconds, label } = ctx.params;
    for (let i = 1; i <= seconds; i++) {
      if (ctx.shouldCancel()) throw new Error("cancelled");
      await sleep(1000);
      ctx.reportProgress(i, seconds, "ticks");
    }
    return { ticks: seconds, ...(label ? { label } : {}) };
  },
};
