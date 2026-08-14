/**
 * AI-generation cost-fetcher registry.
 *
 * Maps an `aiGeneration.provider` value (e.g. "fal-ai") to a function that
 * resolves the actual billed cost from the provider's platform API given a
 * `providerJobId`. Returns a `CostFetchOutcome` — resolved / pending /
 * forbidden (permanent credential problem) / error — so the route can tell
 * "retry later" apart from "this will never work with the current key".
 *
 * Mirrors `lib/analysis/script-providers/registry.ts` but for the AI-generation
 * flow surfaced in the asset preview Generation tab.
 *
 * - `fal-ai`: hits fal's `/v1/models/billing-events` endpoint via the shared
 *   helper in `lib/fal/billing.ts`. NB: needs an ADMIN-scoped key.
 * - any other provider: not registered — caller surfaces "no_provider_fetch_support".
 *
 * Note: test-mode files (fake-fal masquerading as fal-ai) carry
 * `costEstimate.tier === "test-mode"` and are handled provider-agnostically in
 * the refresh-cost route before the fetcher is ever invoked.
 */

import { fetchFalCost } from "@/lib/fal/billing";
import { readFalApiKey } from "@/lib/analysis/script-providers/fal-api-key";
import type { CostFetchOutcome } from "@/lib/providers/cost-outcome";

export interface CostFetcherInput {
  providerJobId: string;
  /** ISO timestamp of the generation — bounds the provider's billing query
   *  window (fal's `start` defaults to 24h ago without it). */
  generatedAt?: string;
  signal?: AbortSignal;
}

export type AiGenerationCostFetcher = (
  input: CostFetcherInput,
) => Promise<CostFetchOutcome>;

const fetchers = new Map<string, AiGenerationCostFetcher>();

export function registerCostFetcher(
  provider: string,
  fn: AiGenerationCostFetcher,
): void {
  fetchers.set(provider, fn);
}

export function getCostFetcher(
  provider: string,
): AiGenerationCostFetcher | null {
  return fetchers.get(provider) ?? null;
}

export function registerBuiltinAiGenerationCostFetchers(): void {
  if (fetchers.has("fal-ai")) return; // idempotent

  // fal-ai — real billing API.
  registerCostFetcher("fal-ai", async ({ providerJobId, generatedAt, signal }) => {
    const key = await readFalApiKey();
    if (!key) {
      return {
        kind: "forbidden",
        message:
          "No fal.ai API key configured — set FAL_KEY on the fal-ai MCP server in Settings to enable cost lookup.",
      };
    }
    return fetchFalCost({ requestId: providerJobId, apiKey: key, generatedAt, signal });
  });

}
