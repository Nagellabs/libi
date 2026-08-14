import { describe, it, expect } from "vitest";
import { windowWordsToElementLocal } from "@/lib/captions/window";

describe("windowWordsToElementLocal — attach a transcript to a custom overlay window", () => {
  const words = [
    { text: "one", start: 1.0, end: 1.4, type: "word" },
    { text: "two", start: 1.5, end: 1.9, type: "word" },
    { text: "three", start: 5.0, end: 5.6, type: "word" }, // outside the window
    { text: ".", start: 1.9, end: 1.9, type: "spacing" }, // non-word token
  ];

  it("keeps only words overlapping [startTime, startTime+duration] and makes them element-local", () => {
    // Overlay window: 1.0s → 3.0s.
    const out = windowWordsToElementLocal(words, 1.0, 2.0);
    expect(out.map((w) => w.text)).toEqual(["one", "two"]); // "three" out, non-word dropped
    // Element-local: relative to startTime (1.0), clamped ≥0.
    expect(out[0].start).toBeCloseTo(0.0, 3);
    expect(out[0].end).toBeCloseTo(0.4, 3);
    expect(out[1].start).toBeCloseTo(0.5, 3);
    expect(out[1].end).toBeCloseTo(0.9, 3);
  });

  it("keeps a word straddling the window's start edge (clamped to 0)", () => {
    // Window starts at 1.2, mid-"one". "one" overlaps → kept, local start clamps to 0.
    const out = windowWordsToElementLocal(words, 1.2, 1.0);
    expect(out.map((w) => w.text)).toEqual(["one", "two"]);
    expect(out[0].start).toBe(0); // 1.0 - 1.2 = -0.2 → clamped
  });

  it("returns empty when nothing overlaps (caller surfaces no_transcript_in_window)", () => {
    expect(windowWordsToElementLocal(words, 10, 2)).toEqual([]);
  });
});
