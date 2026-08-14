import { describe, it, expect } from "vitest";
import {
  analysisTranscribeAudioSchema,
  whisperListModelsSchema,
  whisperDownloadModelSchema,
} from "@/mcp/tools/schemas";

describe("whisper schemas", () => {
  it("analysisTranscribeAudioSchema accepts provider+model", () => {
    const p = analysisTranscribeAudioSchema.parse({
      fileId: "x",
      provider: "whisper",
      model: "small",
    });
    expect(p.provider).toBe("whisper");
    expect(p.model).toBe("small");
  });
  it("analysisTranscribeAudioSchema rejects bad provider", () => {
    expect(() =>
      analysisTranscribeAudioSchema.parse({ fileId: "x", provider: "nope" }),
    ).toThrow();
  });
  it("whisperListModelsSchema is empty object", () => {
    expect(whisperListModelsSchema.parse({})).toEqual({});
  });
  it("whisperDownloadModelSchema requires a model enum", () => {
    expect(whisperDownloadModelSchema.parse({ model: "medium" }).model).toBe(
      "medium",
    );
    expect(() => whisperDownloadModelSchema.parse({ model: "xl" })).toThrow();
  });
});
