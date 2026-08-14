import { describe, it, expect } from "vitest";
import {
  cumulativeLabel,
  currentWord,
  activeWordIndex,
} from "@/lib/engine/text-anim/caption-logic";

// Word timings mirror the real dogfood: "Salon nails… at home"
const WORDS = [
  { text: "Salon", start: 0.0 },
  { text: "nails…", start: 0.46 },
  { text: "at", start: 0.74 },
  { text: "home", start: 1.28 },
];

describe("cumulativeLabel", () => {
  it("is empty before the first word", () => {
    expect(cumulativeLabel(WORDS, -0.1)).toBe("");
  });
  it("builds up word-by-word as time advances", () => {
    expect(cumulativeLabel(WORDS, 0.0)).toBe("Salon");
    expect(cumulativeLabel(WORDS, 0.5)).toBe("Salon nails…");
    expect(cumulativeLabel(WORDS, 0.8)).toBe("Salon nails… at");
    expect(cumulativeLabel(WORDS, 1.3)).toBe("Salon nails… at home");
  });
  it("holds the full sentence after the last word", () => {
    expect(cumulativeLabel(WORDS, 5)).toBe("Salon nails… at home");
  });
});

describe("currentWord", () => {
  it("is null before the first word", () => {
    expect(currentWord(WORDS, -0.1)).toBeNull();
  });
  it("returns only the most-recently-started word (no gaps)", () => {
    expect(currentWord(WORDS, 0.0)).toBe("Salon");
    expect(currentWord(WORDS, 0.5)).toBe("nails…");
    expect(currentWord(WORDS, 0.8)).toBe("at");
    expect(currentWord(WORDS, 1.3)).toBe("home");
    expect(currentWord(WORDS, 9)).toBe("home");
  });
});

describe("activeWordIndex", () => {
  it("is -1 before the first word", () => {
    expect(activeWordIndex(WORDS, -0.1)).toBe(-1);
  });
  it("tracks the active word index for karaoke emphasis", () => {
    expect(activeWordIndex(WORDS, 0.0)).toBe(0);
    expect(activeWordIndex(WORDS, 0.5)).toBe(1);
    expect(activeWordIndex(WORDS, 0.8)).toBe(2);
    expect(activeWordIndex(WORDS, 1.3)).toBe(3);
  });
});
