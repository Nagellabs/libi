import type { DependencyStatus } from "@/lib/queries/mcp-servers";

export type AggregateStatus = "installed" | "installing" | "failed" | "pending";

/** Aggregate a list of dep statuses into the parent MCP-card badge.
 *  Priority: failed > installing > pending > installed.
 *  Empty list is treated as installed (vacuous truth — no gates means
 *  nothing to wait on). */
export function deriveAggregateStatus(deps: DependencyStatus[]): AggregateStatus {
  if (deps.length === 0) return "installed";
  if (deps.some((d) => d.runtimeStatus === "failed")) return "failed";
  if (deps.some((d) => d.runtimeStatus === "installing")) return "installing";
  if (deps.some((d) => d.runtimeStatus === "pending" || !d.installed)) return "pending";
  return "installed";
}
