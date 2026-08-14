import { describe, it, expect } from "vitest";
import { pickAnalysisPrompt } from "@/lib/analysis/script-providers/prompt-builder";
import { buildCaptionAnalysisPrompt } from "@/lib/analysis/script-providers/caption-prompt";
import { buildScriptPrompt } from "@/lib/analysis/script-providers/prompt-builder";

describe("pickAnalysisPrompt", () => {
  it("routes focus 'captions' to the caption analysis prompt", () => {
    expect(pickAnalysisPrompt("captions")).toBe(buildCaptionAnalysisPrompt());
  });
  it("defaults to the full script prompt", () => {
    expect(pickAnalysisPrompt()).toBe(buildScriptPrompt());
    expect(pickAnalysisPrompt("script")).toBe(buildScriptPrompt());
  });
});
