import { describe, it, expect } from "vitest";
import { cardAssetTargets } from "@/lib/storyboard/asset-targets";
import type { StoryboardCard } from "@/lib/storyboard/types";
import type { ModelSchema } from "@/lib/storyboard/gen-schema";

const schema: ModelSchema = {
  apiUrl: "u", model: "m",
  fields: [
    { key: "image_url", type: "image" },
    { key: "end_image_url", type: "image" },
    { key: "reference_video", type: "video" },
  ],
};

function card(partial: Partial<StoryboardCard>): StoryboardCard {
  return {
    id: "c1", order: 0, durationSec: 5, role: "scene", kind: "ai-video", title: "t",
    camera: { shot: "medium" }, promptFragment: "p", stage: "schematic", approvals: {},
    sketches: [
      { id: "sk_1", role: "start", paramKey: "image_url", render: { kind: "satori", file: "f" } },
      { id: "sk_2", role: "end", paramKey: "end_image_url", render: { kind: "satori", file: "f" } },
    ],
    clipGen: { apiUrl: "u", model: "m", params: { image_url: "kf_start" } },
    ...partial,
  } as StoryboardCard;
}

describe("cardAssetTargets", () => {
  it("emits per-slot keyframes + per-slot sketches + schema references, grouped", () => {
    const targets = cardAssetTargets(card({}), schema);
    const byGroup = (g: string) => targets.filter((t) => t.group === g).map((t) => t.label);
    expect(byGroup("Keyframes")).toEqual(["Start frame", "End frame"]);
    expect(byGroup("Sketches")).toEqual(["Start sketch", "End sketch"]);
    expect(byGroup("References")).toEqual(["Reference video"]);
  });

  it("keyframe targets carry the slot's paramKey; sketch targets carry the slotId; references are not keyframes", () => {
    const targets = cardAssetTargets(card({}), schema);
    const startKf = targets.find((t) => t.id === "kf:sk_1")!;
    expect(startKf).toMatchObject({ kind: "keyframe", family: "image", paramKey: "image_url", slotId: "sk_1", filled: true });
    const startSketch = targets.find((t) => t.id === "sk:sk_1")!;
    expect(startSketch).toMatchObject({ kind: "sketch", family: "image", slotId: "sk_1" });
    const ref = targets.find((t) => t.id === "ref:reference_video")!;
    expect(ref).toMatchObject({ kind: "reference", family: "video", paramKey: "reference_video", supportsInherit: true });
    // image_url/end_image_url are keyframes, never offered as references
    expect(targets.some((t) => t.kind === "reference" && (t.paramKey === "image_url" || t.paramKey === "end_image_url"))).toBe(false);
  });

  it("a sketch slot with an imported image flags its sketch target as filled", () => {
    const c = card({
      sketches: [{ id: "sk_1", role: "start", paramKey: "image_url", imageFileId: "img_99" }],
    });
    expect(cardAssetTargets(c, schema).find((t) => t.id === "sk:sk_1")!.filled).toBe(true);
  });
});
