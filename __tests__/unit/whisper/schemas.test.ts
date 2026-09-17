import { describe, it, expect } from "vitest";
import {
  analysisTranscribeAudioSchema,
  whisperListModelsSchema,
  whisperDownloadModelSchema,
} from "@/mcp/tools/schemas";

describe("whisper schemas", () => {
  it("analysisTranscribeAudioSchema accepts model and has no provider field", () => {
    const p = analysisTranscribeAudioSchema.parse({
      fileId: "x",
      model: "small",
    });
    expect(p.model).toBe("small");
    expect("provider" in analysisTranscribeAudioSchema.shape).toBe(false);
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
