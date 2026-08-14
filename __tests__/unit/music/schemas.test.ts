import { describe, it, expect } from "vitest";
import {
  musicListStylesSchema,
  musicDownloadModelSchema,
  generateMusicSchema,
} from "@/mcp/tools/schemas";

describe("music schemas", () => {
  it("list-styles takes no params; download-model takes optional force", () => {
    expect(musicListStylesSchema.safeParse({}).success).toBe(true);
    expect(musicDownloadModelSchema.safeParse({}).success).toBe(true);
    expect(musicDownloadModelSchema.safeParse({ force: true }).success).toBe(true);
  });

  it("generate_music requires prompt and validates ranges", () => {
    expect(generateMusicSchema.safeParse({}).success).toBe(false);
    const ok = generateMusicSchema.safeParse({
      prompt: "calm lofi piano",
      durationSeconds: 30,
      lyrics: "la la la",
      instrumental: false,
      seed: 7,
      confirm: true,
      pieceId: null,
    });
    expect(ok.success).toBe(true);
    expect(
      generateMusicSchema.safeParse({ prompt: "x", durationSeconds: 999 }).success,
    ).toBe(false);
    expect(generateMusicSchema.safeParse({ prompt: "" }).success).toBe(false);
  });
});
