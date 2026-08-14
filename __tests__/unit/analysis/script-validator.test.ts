import { describe, expect, it } from "vitest";
import { parseAndValidateScript } from "@/lib/analysis/script-validator";

const validBody = {
  schema_version: "script_v1",
  duration: 5,
  overall_style: "cinematic",
  shots: [{ index: 0, start: 0, end: 5, description: "shot" }],
  music: { present: false },
};

const providerMeta = {
  providerName: "fal-video-understanding",
  modelId: "gemini-2.5-pro",
  generatedAt: "2026-05-25T00:00:00.000Z",
};

describe("parseAndValidateScript", () => {
  it("returns a Script with injected provider on raw JSON", () => {
    const result = parseAndValidateScript(JSON.stringify(validBody), providerMeta);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.script.provider.name).toBe("fal-video-understanding");
      expect(result.script.provider.model).toBe("gemini-2.5-pro");
      expect(result.script.provider.generatedAt).toBe("2026-05-25T00:00:00.000Z");
    }
  });

  it("strips ```json fenced wrappers", () => {
    const fenced = "```json\n" + JSON.stringify(validBody) + "\n```";
    const result = parseAndValidateScript(fenced, providerMeta);
    expect(result.ok).toBe(true);
  });

  it("strips plain ``` wrappers", () => {
    const fenced = "```\n" + JSON.stringify(validBody) + "\n```";
    const result = parseAndValidateScript(fenced, providerMeta);
    expect(result.ok).toBe(true);
  });

  it("returns ok:false with a non-empty error on malformed JSON", () => {
    const result = parseAndValidateScript("this is not json {{{", providerMeta);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("returns ok:false on schema-validation failure", () => {
    const bad = { ...validBody, shots: [] };
    const result = parseAndValidateScript(JSON.stringify(bad), providerMeta);
    expect(result.ok).toBe(false);
  });

  it("overrides any provider block the model wrote — runner is source of truth", () => {
    const bodyWithFakeProvider = {
      ...validBody,
      provider: { name: "spoofed", model: "evil", generatedAt: "1970-01-01T00:00:00.000Z" },
    };
    const result = parseAndValidateScript(JSON.stringify(bodyWithFakeProvider), providerMeta);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.script.provider.name).toBe("fal-video-understanding");
      expect(result.script.provider.generatedAt).toBe("2026-05-25T00:00:00.000Z");
    }
  });
});
