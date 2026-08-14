import { describe, it, expect } from "vitest";
import {
  frameDescriptionSchema,
  videoSummarySchema,
} from "@/lib/analysis/schemas";

// ──────────────────────────────────────────────────────────────────────────────
// FrameDescription
// ──────────────────────────────────────────────────────────────────────────────

describe("frameDescriptionSchema", () => {
  const minimalValid = {
    schema_version: "frame_v1" as const,
    frame_index: 0,
    timestamp: 0,
    scene: "A quiet street at dusk",
    setting: { location: "city street" },
    people: [],
    objects: [],
  };

  it("accepts a valid minimal FrameDescription", () => {
    const result = frameDescriptionSchema.safeParse(minimalValid);
    expect(result.success).toBe(true);
  });

  it("rejects wrong schema_version", () => {
    const result = frameDescriptionSchema.safeParse({
      ...minimalValid,
      schema_version: "video_v1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects wrong schema_version (arbitrary string)", () => {
    const result = frameDescriptionSchema.safeParse({
      ...minimalValid,
      schema_version: "v1",
    });
    expect(result.success).toBe(false);
  });

  it("custom field accepts arbitrary JSON", () => {
    const result = frameDescriptionSchema.safeParse({
      ...minimalValid,
      custom: {
        nested: { a: 1, b: [true, null, "str"] },
        flag: false,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a person bbox that is a 3-tuple (must be exactly 4 numbers)", () => {
    const result = frameDescriptionSchema.safeParse({
      ...minimalValid,
      people: [
        {
          description: "person",
          bbox: [0.1, 0.2, 0.3], // 3-tuple — invalid
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an object bbox that is a 3-tuple (must be exactly 4 numbers)", () => {
    const result = frameDescriptionSchema.safeParse({
      ...minimalValid,
      objects: [
        {
          name: "chair",
          bbox: [0, 1, 2], // 3-tuple — invalid
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a person bbox that is exactly a 4-tuple", () => {
    const result = frameDescriptionSchema.safeParse({
      ...minimalValid,
      people: [
        {
          description: "person",
          bbox: [0.0, 0.1, 0.5, 0.9],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects scene as empty string", () => {
    const result = frameDescriptionSchema.safeParse({
      ...minimalValid,
      scene: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects people when not an array", () => {
    const result = frameDescriptionSchema.safeParse({
      ...minimalValid,
      people: "not an array",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required field frame_index", () => {
    const { frame_index: _fi, ...withoutFrameIndex } = minimalValid;
    const result = frameDescriptionSchema.safeParse(withoutFrameIndex);
    expect(result.success).toBe(false);
  });

  it("rejects negative frame_index", () => {
    const result = frameDescriptionSchema.safeParse({
      ...minimalValid,
      frame_index: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects float frame_index (must be int)", () => {
    const result = frameDescriptionSchema.safeParse({
      ...minimalValid,
      frame_index: 1.5,
    });
    expect(result.success).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// VideoSummary
// ──────────────────────────────────────────────────────────────────────────────

describe("videoSummarySchema", () => {
  const minimalValid = {
    schema_version: "video_v1" as const,
    overview: "A short documentary about urban farming",
    duration: 120,
    subjects: [],
    sections: [],
    recurring_objects: [],
  };

  it("accepts a valid minimal VideoSummary", () => {
    const result = videoSummarySchema.safeParse(minimalValid);
    expect(result.success).toBe(true);
  });

  it("rejects wrong schema_version", () => {
    const result = videoSummarySchema.safeParse({
      ...minimalValid,
      schema_version: "frame_v1",
    });
    expect(result.success).toBe(false);
  });

  it("VideoSummary custom accepts arbitrary JSON", () => {
    const result = videoSummarySchema.safeParse({
      ...minimalValid,
      custom: {
        model: "claude-sonnet-4-5",
        extra: [1, 2, 3],
        nested: { ok: true },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects overview as empty string", () => {
    const result = videoSummarySchema.safeParse({
      ...minimalValid,
      overview: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects sections.description as empty string", () => {
    const result = videoSummarySchema.safeParse({
      ...minimalValid,
      sections: [
        { start: 0, end: 10, description: "", frame_indices: [] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects subjects when not an array", () => {
    const result = videoSummarySchema.safeParse({
      ...minimalValid,
      subjects: "not an array",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative duration", () => {
    const result = videoSummarySchema.safeParse({
      ...minimalValid,
      duration: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects subject appearance_frame_indices with float (must be int)", () => {
    const result = videoSummarySchema.safeParse({
      ...minimalValid,
      subjects: [
        {
          id: "person-1",
          description: "main subject",
          appearance_frame_indices: [0, 1.5],
          appearance_timestamps: [0, 1.5],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects recurring_objects count as float (must be int)", () => {
    const result = videoSummarySchema.safeParse({
      ...minimalValid,
      recurring_objects: [{ name: "chair", count: 2.5 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects recurring_objects count as negative (must be nonneg)", () => {
    const result = videoSummarySchema.safeParse({
      ...minimalValid,
      recurring_objects: [{ name: "chair", count: -1 }],
    });
    expect(result.success).toBe(false);
  });
});
