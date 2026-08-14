import { describe, it, expect } from "vitest";
import { buildCaptionCues } from "@/lib/captions/cues";
import type { ElevenLabsWord } from "@/lib/elevenlabs/transcribe";

const w = (text: string, start: number, end: number): ElevenLabsWord => ({ text, start, end, type: "word" });

describe("buildCaptionCues", () => {
  it("splits on the char budget and times with lead/hold", () => {
    const words = [w("Chase", 1, 1.3), w("the", 1.3, 1.5), w("horizon", 1.5, 2.0)];
    const cues = buildCaptionCues(words, { maxCharsPerLine: 8, maxLines: 1, lead: 0.1, hold: 0.2 });
    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0].start).toBeCloseTo(0.9, 5); // 1 - 0.1 lead
  });
  it("never overlaps consecutive cues", () => {
    const words = [w("a", 0, 0.5), w("bbbbbbb", 0.5, 1.0), w("c", 1.0, 1.5)];
    const cues = buildCaptionCues(words, { maxCharsPerLine: 3, maxLines: 1, lead: 1.0, hold: 0.1 });
    for (let i = 1; i < cues.length; i++) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end);
  });
  it("ignores non-word tokens", () => {
    const words = [w("hi", 0, 0.4), { text: " ", start: 0.4, end: 0.5, type: "spacing" } as ElevenLabsWord];
    expect(buildCaptionCues(words)).toHaveLength(1);
  });
});
