import { describe, it, expect } from "vitest";
import { audioFadeIn, audioFadeOut } from "@/lib/effects/builtin/audio-fade";

describe("audio fade effects", () => {
  it("fade-in gain ramps 0→1 (reported via opacity field)", () => {
    expect(audioFadeIn.animate(0, {}).opacity).toBeCloseTo(0, 5);
    expect(audioFadeIn.animate(1, {}).opacity).toBeCloseTo(1, 5);
    expect(audioFadeIn.meta.audioEnvelope).toBe(true);
    expect(audioFadeIn.meta.supports).toEqual(["audio"]);
  });
  it("fade-out gain ramps 1→0", () => {
    expect(audioFadeOut.animate(0, {}).opacity).toBeCloseTo(1, 5);
    expect(audioFadeOut.animate(1, {}).opacity).toBeCloseTo(0, 5);
  });
});
