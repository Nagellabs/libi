// __tests__/unit/storyboard/card-view.test.ts
import { describe, it, expect } from "vitest";
import { deriveCardView } from "@/lib/storyboard/card-view";
import type { StoryboardCard } from "@/lib/storyboard/types";

function card(over: Partial<StoryboardCard>): StoryboardCard {
  return {
    id: "c1", order: 0, durationSec: 6, role: "hook", kind: "canvas", title: "Hook",
    sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "sketches/sk_1/unit.jsx" } }],
    camera: { shot: "medium" },
    promptFragment: "x", stage: "schematic", approvals: {},
    ...over,
  };
}

describe("deriveCardView", () => {
  it("T1 approved, T2 generated-not-approved, T3 locked", () => {
    const v = deriveCardView(card({
      stage: "keyframe", keyframeFileId: "k", approvals: { schematic: true },
      cost: { keyframeUsd: 0.04 },
    }));
    const [t1, t2, t3] = v.tiers;
    expect(t1.state).toBe("approved");
    expect(t2.state).toBe("ready");      // generated, awaiting approval
    expect(t3.state).toBe("locked");     // keyframe not approved
    expect(t2.costLabel).toBe("$0.04");
  });

  it("T1 not approved → T2 locked", () => {
    const v = deriveCardView(card({ stage: "schematic", approvals: {} }));
    expect(v.tiers[0].state).toBe("ready"); // schematic present (kind set), awaiting approval
    expect(v.tiers[1].state).toBe("locked");
  });

  it("fully approved clip → T3 done/on-timeline", () => {
    const v = deriveCardView(card({
      stage: "clip", keyframeFileId: "k", clipFileId: "c",
      approvals: { schematic: true, keyframe: true, clip: true },
      // onTimeline now requires a selected visible take, not just approvals.clip
      clips: [{ id: "t1", fileId: "c", label: "v1", createdAt: 0 }],
      selectedClipId: "t1",
    }));
    expect(v.tiers[2].state).toBe("approved");
    expect(v.onTimeline).toBe(true);
  });

  it("approvals.clip alone does not put the card on the timeline", () => {
    const v = deriveCardView(card({
      stage: "clip", keyframeFileId: "k", clipFileId: "c",
      approvals: { schematic: true, keyframe: true, clip: true },
      // no clips / selectedClipId
    }));
    expect(v.tiers[2].state).toBe("approved");
    expect(v.onTimeline).toBe(false);
  });
});
