/**
 * Shared outcome type for "fetch the real billed cost from a provider" calls.
 *
 * The old shape (`number | null`) collapsed every failure into null, which
 * callers rendered as "still pending — try again later". A permanently
 * misconfigured key (fal's billing API needs an ADMIN-scoped key) was
 * therefore indistinguishable from "the billing event hasn't landed yet",
 * and the UI retried forever. The union keeps the states separate:
 *
 * - `resolved`   — a real non-zero charge came back; write it.
 * - `pending`    — the provider answered but hasn't published the charge yet;
 *                  retrying later is meaningful.
 * - `forbidden`  — PERMANENT: the credentials can't read billing data (wrong
 *                  scope, missing key). Retrying will never help; surface the
 *                  message to the user.
 * - `error`      — transient/unknown failure (network, 5xx). Retrying may help.
 *
 * Used by `lib/fal/billing.ts` and both provider layers that wrap it
 * (`lib/ai-generation/cost-fetchers.ts`, `lib/analysis/script-providers/*`).
 */
export type CostFetchOutcome =
  | { kind: "resolved"; amountUsd: number }
  | { kind: "pending" }
  | { kind: "forbidden"; message: string }
  | { kind: "error"; status?: number; message: string };
