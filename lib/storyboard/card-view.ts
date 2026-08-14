// lib/storyboard/card-view.ts
import type { StoryboardCard } from "./types";
import { isOnTimeline } from "./take-view";

export type TierState = "empty" | "ready" | "approved" | "locked";
export type TierView = {
  tier: "schematic" | "keyframe" | "clip";
  state: TierState;
  costLabel?: string;
};
export type CardView = {
  tiers: [TierView, TierView, TierView];
  onTimeline: boolean;
};

const usd = (n?: number) => (n === undefined ? undefined : `$${n.toFixed(2)}`);

/** Pure: map a card's data to the three-tier display state + timeline flag.
 *  A tier is `locked` until the previous tier is approved, `approved` when its
 *  approval flag is set, `ready` when its artifact exists but isn't approved,
 *  else `empty`. Tier-1's artifact is considered present (the agent always
 *  authors a render unit), so it's `ready` until approved. */
export function deriveCardView(card: StoryboardCard): CardView {
  const a = card.approvals;
  const t1: TierView = {
    tier: "schematic",
    state: a.schematic ? "approved" : "ready",
  };
  const t2: TierView = {
    tier: "keyframe",
    state: !a.schematic
      ? "locked"
      : a.keyframe
        ? "approved"
        : card.keyframeFileId
          ? "ready"
          : "empty",
    costLabel: usd(card.cost?.keyframeUsd),
  };
  const t3: TierView = {
    tier: "clip",
    state: !a.keyframe
      ? "locked"
      : a.clip
        ? "approved"
        : card.clipFileId
          ? "ready"
          : "empty",
    costLabel: usd(card.cost?.clipUsd),
  };
  return { tiers: [t1, t2, t3], onTimeline: isOnTimeline(card) };
}
