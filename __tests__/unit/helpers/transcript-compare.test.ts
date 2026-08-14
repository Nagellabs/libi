import { describe, it, expect } from "vitest";
import {
  normalize,
  wordErrorRate,
  assertTranscriptShape,
  assertTimingAligned,
} from "@/__tests__/helpers/transcript-compare";

describe("transcript-compare", () => {
  it("normalize lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalize("  Hello, WORLD!!  Foo. ")).toBe("hello world foo");
  });

  it("wordErrorRate is 0 for identical, 1 for fully different", () => {
    expect(wordErrorRate("a b c", "a b c")).toBe(0);
    expect(wordErrorRate("x y z", "a b c")).toBe(1);
    expect(wordErrorRate("a b", "a b c")).toBeCloseTo(1 / 3, 5);
  });

  it("assertTranscriptShape accepts a valid word array", () => {
    expect(() =>
      assertTranscriptShape(
        [
          { text: "a", start: 0, end: 0.5, type: "word", speaker_id: null },
          { text: "b", start: 0.5, end: 1.0, type: "word", speaker_id: null },
        ],
        2,
      ),
    ).not.toThrow();
  });

  it("assertTranscriptShape rejects non-monotonic / out-of-range timing", () => {
    expect(() =>
      assertTranscriptShape(
        [{ text: "a", start: 5, end: 4, type: "word", speaker_id: null }],
        2,
      ),
    ).toThrow();
  });

  it("assertTimingAligned passes when starts track the reference", () => {
    const ref = [
      { text: "ask", start: 1.0, end: 1.2 },
      { text: "not", start: 1.2, end: 1.4 },
      { text: "what", start: 1.4, end: 1.6 },
    ];
    const hyp = [
      { text: "Ask", start: 1.05, end: 1.25, type: "word", speaker_id: null },
      { text: "not", start: 1.22, end: 1.45, type: "word", speaker_id: null },
      { text: "what", start: 1.43, end: 1.65, type: "word", speaker_id: null },
    ];
    expect(() =>
      assertTimingAligned(hyp, ref, { medianMs: 300, p95Ms: 700 }),
    ).not.toThrow();
  });

  it("assertTimingAligned throws when too few words align", () => {
    expect(() =>
      assertTimingAligned(
        [{ text: "zzz", start: 0, end: 1, type: "word", speaker_id: null }],
        [{ text: "ask", start: 1, end: 2 }],
        { medianMs: 300, p95Ms: 700 },
      ),
    ).toThrow(/too few/);
  });
});
