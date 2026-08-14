/**
 * Shared fal.ai billing-events helper.
 *
 * Both the script-analysis cost-refresh path (script-providers/fal-video-understanding.ts)
 * and the AI-generation cost-refresh path (api/files/.../generation/refresh-cost) hit
 * fal's platform billing API to resolve actual cost-after-completion.
 * One helper, two call sites.
 *
 * Endpoint: https://api.fal.ai/v1/models/billing-events?request_id=<id>&start=<iso>
 * Auth:     Authorization: Key <FAL_KEY> — and the key MUST be ADMIN-scoped.
 *           API-scoped keys (the kind that runs generations) get 403
 *           `authorization_error` here; ADMIN scope is a superset ("everything
 *           in API, plus…"), so one ADMIN key can serve both generation and
 *           billing lookups. Verified live 2026-07-04.
 * Window:   `start` DEFAULTS TO 24 HOURS AGO on fal's side — without an
 *           explicit `start`, any request older than a day returns zero
 *           events and looks forever-pending. Callers pass the generation
 *           timestamp; we widen it by an hour of clock-skew margin.
 * Response: { billing_events: [{ cost_estimate_nano_usd: number, ... }] }
 *
 * A literal 0 is "not yet populated" (fal occasionally returns the row with
 * cost_estimate_nano_usd === 0 before the real charge lands) → `pending`.
 *
 * Docs: https://fal.ai/docs/platform-apis/v1/models/billing-events.md
 */

import type { CostFetchOutcome } from "@/lib/providers/cost-outcome";

export const FAL_BILLING_URL = "https://api.fal.ai/v1/models/billing-events";

/** User-facing explanation for the permanent 403 case. */
export const FAL_ADMIN_SCOPE_HINT =
  "The configured fal.ai API key can't read billing data — fal's billing API requires an ADMIN-scoped key. Create one at fal.ai → Dashboard → Keys (scope: ADMIN — it runs generations too) and update the FAL_KEY on the fal-ai MCP server in Settings.";

const FALLBACK_WINDOW_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
// Generous on purpose: stored generation timestamps aren't trustworthy —
// real rows exist whose completedAt is local wall-clock mislabeled as UTC
// (3h ahead of the billing event's true UTC timestamp). The query is
// request_id-filtered, so a wide window can't match the wrong event; it only
// bounds fal's scan.
const SKEW_MARGIN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** fal's `start` defaults to 24h ago; compute an explicit window start from
 *  the generation timestamp (or a wide fallback when it's missing/invalid). */
export function billingWindowStart(
  generatedAt: string | undefined,
  now: number = Date.now(),
): string {
  const parsed = generatedAt ? Date.parse(generatedAt) : NaN;
  const base = Number.isFinite(parsed) ? parsed : now - FALLBACK_WINDOW_MS;
  return new Date(base - SKEW_MARGIN_MS).toISOString();
}

export async function fetchFalCost(args: {
  requestId: string;
  apiKey: string;
  /** ISO timestamp of the generation; drives the billing query's `start`. */
  generatedAt?: string;
  signal?: AbortSignal;
}): Promise<CostFetchOutcome> {
  const { requestId, apiKey, generatedAt, signal } = args;
  const params = new URLSearchParams({
    request_id: requestId,
    start: billingWindowStart(generatedAt),
  });
  const url = `${FAL_BILLING_URL}?${params.toString()}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { Authorization: `Key ${apiKey}` },
      signal,
    });
  } catch (err) {
    return {
      kind: "error",
      message: `fal billing request failed: ${(err as Error).message}`,
    };
  }

  if (resp.status === 401 || resp.status === 403) {
    return { kind: "forbidden", message: FAL_ADMIN_SCOPE_HINT };
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return {
      kind: "error",
      status: resp.status,
      message: `fal billing API returned HTTP ${resp.status}: ${body.slice(0, 200)}`,
    };
  }

  const body = (await resp.json().catch(() => null)) as {
    billing_events?: Array<{ cost_estimate_nano_usd?: number }>;
  } | null;
  const event = body?.billing_events?.[0];
  if (!event || typeof event.cost_estimate_nano_usd !== "number") {
    return { kind: "pending" };
  }
  if (event.cost_estimate_nano_usd === 0) {
    return { kind: "pending" };
  }
  return { kind: "resolved", amountUsd: event.cost_estimate_nano_usd / 1_000_000_000 };
}
