import { describe, it, expect } from "vitest";
import { buildCaptionAnalysisPrompt } from "@/lib/analysis/script-providers/caption-prompt";
describe("buildCaptionAnalysisPrompt", () => {
  it("asks for per-caption numeric keyframes + anchor + flat-engine params", () => {
    const p = buildCaptionAnalysisPrompt();
    expect(p).toMatch(/anchor/i);
    expect(p).toMatch(/keyframe/i);
    expect(p).toMatch(/height/i);            // size as fraction of frame
    expect(p).toMatch(/flat text plane|no extruded|no bloom/i); // engine constraint
    expect(p.length).toBeLessThan(5000);     // fal 5000-char cap
  });
});
