import { describe, it, expect } from "vitest";
import {
  REVEAL_SAMPLE_WORDS,
  revealWordStates,
  revealTypewriterCount,
} from "@/lib/captions/reveal-preview";

describe("reveal-preview", () => {
  const n = REVEAL_SAMPLE_WORDS.length;

  it("none: all words fully shown at any progress", () => {
    const s = revealWordStates("none", 0, n);
    expect(s.every((w) => w.opacity === 1 && w.visible)).toBe(true);
  });

  it("fade-words: nothing at p=0, everything at p=1", () => {
    expect(revealWordStates("fade-words", 0, n)[0].opacity).toBeCloseTo(0);
    expect(revealWordStates("fade-words", 1, n).every((w) => w.opacity === 1)).toBe(true);
  });

  it("slide-up: words start offset and settle to 0", () => {
    expect(revealWordStates("slide-up", 0, n)[0].translateYPx).toBeGreaterThan(0);
    expect(revealWordStates("slide-up", 1, n).every((w) => w.translateYPx === 0)).toBe(true);
  });

  it("karaoke: exactly one highlighted word, advancing with progress", () => {
    const early = revealWordStates("karaoke", 0.05, n);
    const late = revealWordStates("karaoke", 0.95, n);
    expect(early.filter((w) => w.highlighted)).toHaveLength(1);
    expect(early.findIndex((w) => w.highlighted)).toBe(0);
    expect(late.findIndex((w) => w.highlighted)).toBe(n - 1);
  });

  it("word-current: only the active word is visible", () => {
    const s = revealWordStates("word-current", 0.05, n);
    expect(s.filter((w) => w.visible)).toHaveLength(1);
    expect(s.findIndex((w) => w.visible)).toBe(0);
  });

  it("typewriter: char count scales 0→len with progress", () => {
    expect(revealTypewriterCount(0, 10)).toBe(0);
    expect(revealTypewriterCount(1, 10)).toBe(10);
    expect(revealTypewriterCount(0.5, 10)).toBe(5);
  });
});
