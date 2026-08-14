import type { Storyboard } from "./types";

export type CostSummary = {
  keyframeUsd: number;
  clipUsd: number;
  totalUsd: number;
  budgetUsd?: number;
  remainingUsd?: number;
};

/** Sum recorded per-card costs by tier + total, against the optional budget. */
export function storyboardCostSummary(sb: Storyboard): CostSummary {
  let keyframeUsd = 0;
  let clipUsd = 0;
  for (const c of sb.cards) {
    keyframeUsd += c.cost?.keyframeUsd ?? 0;
    clipUsd += c.cost?.clipUsd ?? 0;
  }
  const totalUsd = keyframeUsd + clipUsd;
  return {
    keyframeUsd,
    clipUsd,
    totalUsd,
    budgetUsd: sb.budgetUsd,
    remainingUsd: sb.budgetUsd === undefined ? undefined : sb.budgetUsd - totalUsd,
  };
}
