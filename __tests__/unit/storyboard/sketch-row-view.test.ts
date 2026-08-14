import { describe, it, expect } from "vitest";
import { sketchSlotViews, partitionSketchRows } from "@/lib/storyboard/sketch-row-view";
import type { StoryboardCard } from "@/lib/storyboard/types";

function card(partial: Partial<StoryboardCard>): StoryboardCard {
  return {
    id: "c1", order: 0, durationSec: 5, role: "scene", kind: "ai-video", title: "t",
    camera: { shot: "medium" }, promptFragment: "p", stage: "schematic", approvals: {},
    sketches: [], ...partial,
  } as StoryboardCard;
}

describe("sketchSlotViews", () => {
  it("orders start, end, references and joins the realized image from clipGen params", () => {
    const c = card({
      sketches: [
        { id: "sk_3", role: "reference", paramKey: "reference_image", label: "hand", render: { kind: "satori", file: "f" } },
        { id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "f" } },
        { id: "sk_2", role: "end", paramKey: "end_frame", render: { kind: "satori", file: "f" } },
      ],
      clipGen: { apiUrl: "a", model: "m", params: { start_frame: "img_start", reference_image: "img_ref" } },
    });
    const views = sketchSlotViews(c);
    expect(views.map((v) => v.slotId)).toEqual(["sk_1", "sk_2", "sk_3"]);
    expect(views[0]).toMatchObject({ role: "start", label: "start keyframe", hasSketch: true, imageFileId: "img_start" });
    expect(views[1]).toMatchObject({ role: "end", label: "end keyframe", imageFileId: undefined });
    expect(views[2]).toMatchObject({ role: "reference", label: "hand", imageFileId: "img_ref" });
  });

  // Regression for Finding A (2026-06-16 QA run): the pairing joins on the EXACT
  // key (clipGen.params[slot.paramKey]). If a slot keeps the convention key
  // (start_frame/end_frame) while the clip spec uses the model's real keys
  // (Seedance: image_url/end_image_url), NOTHING pairs — the generated keyframes
  // are orphaned. Re-keying the slots (via edit_storyboard_card editSketch) fixes it.
  it("does NOT pair when slot paramKey diverges from the model's real clip-gen key", () => {
    const c = card({
      sketches: [
        { id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "f" } },
        { id: "sk_2", role: "end", paramKey: "end_frame", render: { kind: "satori", file: "f" } },
      ],
      // Seedance i2v real params — keyed image_url/end_image_url, not start/end_frame
      clipGen: { apiUrl: "a", model: "m", params: { image_url: "img_start", end_image_url: "img_end" } },
    });
    const views = sketchSlotViews(c);
    expect(views.every((v) => v.imageFileId === undefined)).toBe(true);
  });

  it("pairs once the slots are re-keyed to the model's real params", () => {
    const c = card({
      sketches: [
        { id: "sk_1", role: "start", paramKey: "image_url", render: { kind: "satori", file: "f" } },
        { id: "sk_2", role: "end", paramKey: "end_image_url", render: { kind: "satori", file: "f" } },
      ],
      clipGen: { apiUrl: "a", model: "m", params: { image_url: "img_start", end_image_url: "img_end" } },
    });
    const views = sketchSlotViews(c);
    expect(views[0]).toMatchObject({ role: "start", imageFileId: "img_start" });
    expect(views[1]).toMatchObject({ role: "end", imageFileId: "img_end" });
  });

  it("a direct-pick slot (no render) reports hasSketch=false", () => {
    const c = card({
      sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame" }],
      clipGen: { apiUrl: "a", model: "m", params: { start_frame: "img" } },
    });
    expect(sketchSlotViews(c)[0]).toMatchObject({ hasSketch: false, imageFileId: "img" });
  });
});

describe("partitionSketchRows", () => {
  it("groups image-less sketches into one shared row; each imaged slot gets its own row", () => {
    const c = card({
      sketches: [
        { id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "f" } },
        { id: "sk_2", role: "end", paramKey: "end_frame", render: { kind: "satori", file: "f" } },
      ],
      clipGen: { apiUrl: "a", model: "m", params: { start_frame: "img_start" } },
    });
    const { pairedRows, sketchOnlyRow } = partitionSketchRows(sketchSlotViews(c));
    expect(pairedRows.map((r) => r.slotId)).toEqual(["sk_1"]);
    expect(sketchOnlyRow.map((v) => v.slotId)).toEqual(["sk_2"]);
  });

  it("with no images, all sketches share one row and there are no paired rows", () => {
    const c = card({
      sketches: [
        { id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "f" } },
        { id: "sk_2", role: "end", paramKey: "end_frame", render: { kind: "satori", file: "f" } },
      ],
    });
    const { pairedRows, sketchOnlyRow } = partitionSketchRows(sketchSlotViews(c));
    expect(pairedRows).toHaveLength(0);
    expect(sketchOnlyRow.map((v) => v.slotId)).toEqual(["sk_1", "sk_2"]);
  });
});
