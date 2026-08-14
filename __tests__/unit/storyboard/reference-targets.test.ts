import { describe, it, expect } from "vitest";
import { referenceTargets } from "@/lib/storyboard/reference-targets";
import type { ModelSchema } from "@/lib/storyboard/gen-schema";

const schema: ModelSchema = {
  apiUrl: "u",
  model: "m",
  fields: [
    { key: "prompt", type: "text" },
    { key: "image_url", type: "image" }, // start keyframe (catalog: not Keyframing by key, but start_frame is)
    { key: "start_frame", type: "image" }, // keyframe — excluded
    { key: "end_frame", type: "image" }, // keyframe — excluded
    { key: "reference_video", type: "video" },
    { key: "reference_images", type: "image", multiple: true },
    { key: "audio_ref", type: "audio" },
    { key: "duration", type: "number" },
  ],
};

describe("referenceTargets", () => {
  it("returns media reference params, excluding the start/end keyframe params and non-media fields", () => {
    const targets = referenceTargets(schema, {});
    expect(targets.map((t) => t.key)).toEqual(["image_url", "reference_video", "reference_images", "audio_ref"]);
    // start_frame/end_frame (Keyframing) and prompt/duration are excluded
    expect(targets.find((t) => t.key === "start_frame")).toBeUndefined();
    expect(targets.find((t) => t.key === "prompt")).toBeUndefined();
  });

  it("maps each target's family from the schema field type and labels via the catalog", () => {
    const targets = referenceTargets(schema, {});
    expect(targets.find((t) => t.key === "reference_video")).toMatchObject({ family: "video", label: "Reference video" });
    expect(targets.find((t) => t.key === "audio_ref")).toMatchObject({ family: "audio", label: "Audio reference" });
    expect(targets.find((t) => t.key === "reference_images")).toMatchObject({ family: "image", label: "Reference images" });
  });

  it("flags filled when the param already carries a value", () => {
    const targets = referenceTargets(schema, { reference_video: "file_1", reference_images: [] });
    expect(targets.find((t) => t.key === "reference_video")!.filled).toBe(true);
    expect(targets.find((t) => t.key === "reference_images")!.filled).toBe(false);
    expect(targets.find((t) => t.key === "audio_ref")!.filled).toBe(false);
  });

  it("excludes model-specific keyframe params via keyframeKeys (the sketch-slot paramKeys)", () => {
    // Seedance-style schema: image_url/end_image_url are the REAL keyframe params,
    // bound to the start/end sketch slots — they must NOT appear as references even
    // though the catalog doesn't know them as Keyframing.
    const seedance: ModelSchema = {
      apiUrl: "u", model: "m",
      fields: [
        { key: "image_url", type: "image" },
        { key: "end_image_url", type: "image" },
        { key: "reference_video", type: "video" },
      ],
    };
    const targets = referenceTargets(seedance, {}, ["image_url", "end_image_url"]);
    expect(targets.map((t) => t.key)).toEqual(["reference_video"]);
  });

  it("returns [] for an undefined schema (model has no known reference inputs)", () => {
    expect(referenceTargets(undefined)).toEqual([]);
  });
});
