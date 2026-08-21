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
  /**
   * Go SILENT after this many ticks — stop reporting progress while continuing
   * to work, then report once at the end.
   *
   * Reproduces the shape that produced the frozen ETA: a job whose remaining
   * work sits inside one opaque unit (the ACE-Step transformer was a single
   * 6.6 GB file inside a file-counted job, silent for 24 minutes). Without a way
   * to make a job go quiet on demand, the only reproduction was an 8.3 GB
   * download, and the states that follow from it — a decaying ETA, a withdrawn
   * ETA, the "no progress for Xm" line, a heartbeat-refreshed row — could not be
   * looked at in the real UI at all.
   */
  quietAfter: z.number().int().min(1).max(600).optional(),
});

export type DevSlowParams = z.infer<typeof paramsSchema>;
export interface DevSlowResult {
  ticks: number;
  label?: string;
  quietTicks?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const devSlowRunner: JobRunner<DevSlowParams, DevSlowResult> = {
  kind: "dev_slow",
  maxConcurrent: 4,
  resumable: false,
  paramsSchema: paramsSchema as unknown as z.ZodSchema<DevSlowParams>,
  mcpToolId: makeMcpToolId("libi", "libi.dev_slow_job"),

  // A quiet run is silent BY DESIGN, so the no-progress watchdog would kill it.
  // The runners this reproduces (model downloads) opt out for the same reason.
  noProgressTimeoutMs: null,

  async run(ctx: JobContext<DevSlowParams>): Promise<DevSlowResult> {
    const { seconds, label, quietAfter } = ctx.params;
    let quietTicks = 0;
    for (let i = 1; i <= seconds; i++) {
      if (ctx.shouldCancel()) throw new Error("cancelled");
      await sleep(1000);
      if (quietAfter !== undefined && i > quietAfter) {
        // Working, saying nothing — exactly what a multi-GB single file does.
        quietTicks++;
        continue;
      }
      ctx.reportProgress(i, seconds, "ticks");
    }
    // One final tick so the job still ends at 100%, like a real download whose
    // last file lands.
    if (quietTicks > 0) ctx.reportProgress(seconds, seconds, "ticks");
    return {
      ticks: seconds,
      ...(label ? { label } : {}),
      ...(quietTicks > 0 ? { quietTicks } : {}),
    };
  },
};
