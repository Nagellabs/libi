import { z } from "zod/v3";
import type { JobContext, JobRunner } from "@/lib/jobs/types";
import { CancelledError } from "@/lib/jobs/types";
import type { TrackSample } from "@/lib/tracking/types";
import { isTestMode } from "@/lib/test-mode";
import { runSam2FalBackend } from "@/lib/tracking/sam2-fal-backend";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";

// Inputs for external-provider tracking. Mirrors TrackingParams but without
// resumable-frame bookkeeping — providers manage their own progress internally.
const trackingProviderParamsSchema = z.object({
  fileId: z.string().min(1),
  pieceId: z.string().min(1),
  fileUrl: z.string().min(1),
  fps: z.number().int().positive(),
  objectKind: z.enum(["face", "object"]),
  anchors: z
    .array(
      z.object({
        fileId: z.string().min(1),
        time: z.number().nonnegative(),
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      }),
    )
    .min(1)
    .max(100),
  /** Required: which external provider to invoke. */
  provider: z.enum(["sam2-fal"]),
  subjectId: z.string().optional(),
  label: z.string().optional(),
});

export type TrackingProviderParams = z.infer<typeof trackingProviderParamsSchema>;

export interface TrackingProviderResult {
  samples: TrackSample[];
  framerate: number;
}

// Runner shape for each external tracking backend.
type ProviderBackend = (ctx: JobContext<TrackingProviderParams>) => Promise<{
  samples: TrackSample[];
  framerate: number;
}>;

// Record keyed by the provider enum — TypeScript enforces exhaustiveness when
// the enum widens (e.g. adding "sam2-local" in Phase 3 requires an entry here).
const PROVIDER_BACKENDS: Record<TrackingProviderParams["provider"], ProviderBackend> = {
  "sam2-fal": runSam2FalBackend,
};

export const trackingProviderRunner: JobRunner<TrackingProviderParams, TrackingProviderResult> = {
  kind: "tracking_provider",
  mcpToolId: [
    makeMcpToolId("libi", "libi.compute_object_track_providers"),
    makeMcpToolId("libi-tracking", "libi.compute_object_track_providers"),
  ],
  // fal.ai SAM2 mask segmentation — spends money on an external provider API.
  paid: true,
  // External API calls don't compete for local CPU — higher concurrency is safe.
  maxConcurrent: 2,
  paramsSchema: trackingProviderParamsSchema,
  resumable: true,
  // Upload of large source videos can take minutes on slow uplinks; fal.ai's
  // queue can sit IN_QUEUE for minutes before processing starts. 300s gives
  // comfortable headroom while the upload heartbeat (via stream data events)
  // keeps last_progress_at fresh every ~1s during the upload phase.
  noProgressTimeoutMs: 300_000,
  async run(ctx: JobContext<TrackingProviderParams>): Promise<TrackingProviderResult> {
    // Defense-in-depth: the MCP tool gates this too, but a direct POST /api/jobs
    // call in test mode must not reach a paid API.
    if (isTestMode()) {
      throw new Error("providers_disabled_in_test_mode");
    }

    const backend = PROVIDER_BACKENDS[ctx.params.provider];
    if (!backend) {
      throw new Error(`Unknown tracking provider: ${String(ctx.params.provider)}`);
    }
    const out = await backend(ctx);

    if (ctx.shouldCancel()) throw new CancelledError(ctx.jobId);

    return { samples: out.samples, framerate: out.framerate };
  },
};
