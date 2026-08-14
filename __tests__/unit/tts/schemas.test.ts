import { describe, it, expect } from "vitest";
import {
  ttsListVoicesSchema,
  ttsDownloadModelSchema,
  generateSpeechSchema,
} from "@/mcp/tools/schemas";

describe("tts schemas", () => {
  it("list-voices + download-model take no required params", () => {
    expect(ttsListVoicesSchema.safeParse({}).success).toBe(true);
    expect(ttsDownloadModelSchema.safeParse({}).success).toBe(true);
  });

  it("generate_speech requires text and validates ranges", () => {
    expect(generateSpeechSchema.safeParse({}).success).toBe(false);
    const ok = generateSpeechSchema.safeParse({
      text: "Hello",
      voice: "am_adam",
      speed: 1.5,
      withTimestamps: true,
      pieceId: null,
    });
    expect(ok.success).toBe(true);
    expect(generateSpeechSchema.safeParse({ text: "x", speed: 5 }).success).toBe(
      false,
    );
    expect(generateSpeechSchema.safeParse({ text: "" }).success).toBe(false);
  });
});
