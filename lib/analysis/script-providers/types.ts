import type { CostFetchOutcome } from "@/lib/providers/cost-outcome";

export interface ScriptProviderInput {
  /** Absolute path to the source video on disk. */
  localPath: string;
  /** Duration in seconds, for cost estimation and prompt tuning. */
  durationSeconds: number;
  /** The full prompt the runner built (system + user instructions combined). */
  promptInstructions: string;
  /** Aborts in-flight HTTP work. */
  signal?: AbortSignal;
  /** Free-text progress notes (e.g. "uploaded to fal CDN", "polling: IN_PROGRESS"). */
  onProgress?: (note: string) => void;
}

export interface ScriptProviderResult {
  /** Raw model text — expected to be JSON conforming to scriptSchema. */
  text: string;
  /** Provider id, copied into script.provider.name. */
  providerName: string;
  /** Model id reported by the provider, if any. Falls back to provider.defaultModelId in the runner. */
  modelId?: string;
  /** External provider's request/job id (e.g. fal's `request_id`). The runner
   *  persists this in `script.provider.requestId` so a user-initiated cost
   *  refresh can look up the real billed amount later. Optional — providers
   *  without a billing API can omit. */
  requestId?: string;
}

export interface ScriptProvider {
  /** Stable id used in tool args + storage row keys. */
  id: string;
  displayName: string;
  /** Default model id when the caller doesn't specify one. */
  defaultModelId: string;
  /** Hard cap on the length (in characters) of a single prompt field this
   *  provider accepts. fal-ai/video-understanding rejects prompts longer than
   *  5000 chars with HTTP 422 *before billing*. The runner uses this to bound
   *  the retry prompt (whose embedded validation error can otherwise balloon
   *  past the cap when the first response was truncated/garbage). Optional —
   *  providers with no known limit omit it and the runner skips bounding. */
  maxPromptChars?: number;
  /** Reads credentials/settings; called at tool entry to validate before enqueue. */
  isConfigured(): Promise<boolean>;
  /** Performs the upload (if needed) + analysis call + returns raw text. */
  generate(input: ScriptProviderInput): Promise<ScriptProviderResult>;
  /** Heuristic price estimate from input characteristics (typically duration).
   *  Used by the runner at generation time (and by the UI to seed the chip
   *  before the user clicks "refresh"). Optional — providers that don't know
   *  their pricing should omit this; cost will be saved as `null` and the
   *  UI shows no cost. Returns a non-negative USD number. */
  estimateCostUsd?(input: { durationSeconds: number }): number;
  /** Look up the real billed amount from the provider's billing API given
   *  the request id we saved at generation time. Returns a `CostFetchOutcome`
   *  so the wrapping endpoint can distinguish "not published yet" (retry
   *  later) from a permanent credential problem (fal: key not ADMIN-scoped).
   *  `generatedAt` bounds the provider's billing query window — fal's `start`
   *  defaults to 24h ago, so old requests return nothing without it. Single
   *  attempt per call — the API endpoint that wraps this is responsible for
   *  retrying. Optional — providers without a billing-events API should omit. */
  fetchRealCostUsd?(input: {
    requestId: string;
    generatedAt?: string;
    signal?: AbortSignal;
  }): Promise<CostFetchOutcome>;
}
