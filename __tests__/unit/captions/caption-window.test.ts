import { describe, it, expect } from "vitest";
import { windowWordsToElementLocal, wordsSaidByText } from "@/lib/captions/window";

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

describe("windowWordsToElementLocal { byStart } — a TEXT cue owns a word by its start, half-open", () => {
  const contiguous = [
    { text: "And", start: 2.3, end: 2.5, type: "word" },
    { text: "so", start: 2.5, end: 2.7, type: "word" },
    { text: "my", start: 2.7, end: 2.9, type: "word" },
  ];

  it("a window ending on the next word's start does not take it; one starting there does", () => {
    expect(windowWordsToElementLocal(contiguous, 2.3, 0.4, { byStart: true }).map((w) => w.text)).toEqual(["And", "so"]);
    expect(windowWordsToElementLocal(contiguous, 2.7, 0.2, { byStart: true }).map((w) => w.text)).toEqual(["my"]);
  });

  it("without byStart the inclusive overlap (code/three captions) is unchanged", () => {
    expect(windowWordsToElementLocal(contiguous, 2.7, 0.2).map((w) => w.text)).toEqual(["so", "my"]);
  });

  it("a boundary a float hair off the word's start still counts", () => {
    expect(windowWordsToElementLocal(contiguous, 0.7 + 2 + 1e-9, 0.2, { byStart: true }).map((w) => w.text)).toEqual(["my"]);
  });
});

describe("wordsSaidByText — keep the words a cue's text says", () => {
  const w = (text: string, start: number) => ({ text, start, end: start + 0.2 });

  it("drops a lead-in / held-over neighbour by best match", () => {
    const heard = [w("so", 0), w("my", 0.2), w("fellow", 0.4), w("Americans,", 0.6)];
    expect(wordsSaidByText(heard, "My fellow Americans").map((x) => x.text)).toEqual(["my", "fellow", "Americans,"]);
    expect(wordsSaidByText(heard, "so my").map((x) => x.text)).toEqual(["so", "my"]);
  });

  it("ignores standalone punctuation / emoji tokens when counting", () => {
    const heard = [w("ask", 0), w("not", 0.2), w("what", 0.4)];
    expect(wordsSaidByText(heard, "— ask not").map((x) => x.text)).toEqual(["ask", "not"]);
  });

  it("returns the words unchanged when the text has as many or more words", () => {
    const heard = [w("ask", 0), w("not", 0.2)];
    expect(wordsSaidByText(heard, "ask not what")).toBe(heard);
    expect(wordsSaidByText(heard, "")).toBe(heard);
  });
});
