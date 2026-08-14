import { describe, expect, it } from "vitest";
import { scriptSchema, shotSchema } from "@/lib/analysis/schemas";

describe("scriptSchema", () => {
  const valid = {
    schema_version: "script_v1" as const,
    duration: 12.5,
    overall_style: "cinematic UGC, handheld, warm grade",
    shots: [
      {
        index: 0,
        start: 0,
        end: 3.2,
        description: "Medium close-up of a 30yo woman walking through a Tokyo alley.",
        camera: { shot: "medium" as const, motion: "handheld" as const },
        mood: "introspective",
      },
    ],
    music: { present: true, genre: "lo-fi hip-hop", mood: "melancholic" },
    provider: {
      name: "fal-video-understanding",
      model: "gemini-2.5-pro",
      generatedAt: "2026-05-25T10:00:00.000Z",
    },
  };

  it("accepts a well-formed script", () => {
    const result = scriptSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects an empty shots array", () => {
    const result = scriptSchema.safeParse({ ...valid, shots: [] });
    expect(result.success).toBe(false);
  });

  it("rejects wrong schema_version literal", () => {
    const result = scriptSchema.safeParse({ ...valid, schema_version: "script_v2" });
    expect(result.success).toBe(false);
  });

  it("requires music.present", () => {
    const result = scriptSchema.safeParse({ ...valid, music: {} });
    expect(result.success).toBe(false);
  });

  it("accepts the new motion enum values (dolly, tracking, handheld)", () => {
    const shotResult = shotSchema.safeParse({
      index: 0,
      start: 0,
      end: 1,
      description: "x",
      camera: { motion: "dolly" },
    });
    expect(shotResult.success).toBe(true);
  });
});
