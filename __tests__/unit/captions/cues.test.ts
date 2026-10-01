import { describe, it, expect } from "vitest";
import { buildCaptionCues, captionCharsPerLine } from "@/lib/captions/cues";
import type { SttWord } from "@/lib/analysis/types";

const w = (text: string, start: number, end: number): SttWord => ({ text, start, end, type: "word" });

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
    const words = [w("hi", 0, 0.4), { text: " ", start: 0.4, end: 0.5, type: "spacing" } as SttWord];
    expect(buildCaptionCues(words)).toHaveLength(1);
  });

  it("trims leading/trailing whitespace off each word before joining (no leading or double spaces)", () => {
    // Some STT backends (whisper.cpp) prepend a space to every non-first token.
    const words = [w(" Chase", 1, 1.3), w(" the", 1.3, 1.5), w(" horizon ", 1.5, 2.0)];
    const cues = buildCaptionCues(words, { maxCharsPerLine: 100, maxLines: 2 });
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("Chase the horizon");
    expect(cues[0].text.startsWith(" ")).toBe(false);
    expect(cues[0].text.includes("  ")).toBe(false);
  });

  it("floors the lead-in at 0 so the first cue never starts negative", () => {
    const words = [w("Hi", 0.05, 0.4)];
    const cues = buildCaptionCues(words, { lead: 0.15 });
    expect(cues[0].start).toBe(0);
  });

  it("clamps the held end to maxEnd, never below the cue's start", () => {
    const words = [w("Hello", 0, 0.4), w("there", 0.5, 0.9), w("world", 4.8, 5.0)];
    // Default hold (0.4) would push the last cue's end to 5.4; maxEnd (the
    // video's own end) must win.
    const cues = buildCaptionCues(words, { maxCharsPerLine: 100, maxLines: 2, maxEnd: 5.0 });
    for (const c of cues) {
      expect(c.end).toBeLessThanOrEqual(5.0);
      expect(c.end).toBeGreaterThanOrEqual(c.start);
    }
    expect(cues[cues.length - 1].end).toBeCloseTo(5.0, 5);
  });

  it("drops a cue that would start at or after maxEnd", () => {
    const words = [w("Hello", 0, 0.4), w("late", 10, 10.4)];
    const cues = buildCaptionCues(words, { maxCharsPerLine: 4, maxLines: 1, maxEnd: 1.0 });
    // Only the first cue survives — the second starts (even lead-adjusted) at/after maxEnd.
    expect(cues.length).toBe(1);
    expect(cues[0].text).toBe("Hello");
  });

  it("with no maxEnd, behaves exactly as before (no clamp)", () => {
    const words = [w("Hello", 0, 0.4)];
    const cues = buildCaptionCues(words, { hold: 0.4 });
    expect(cues[0].end).toBeCloseTo(0.8, 5);
  });

  it("floors the lead-in at minStart instead of 0 (words already shifted onto a timeline)", () => {
    // Simulates a caller (caption-tools.ts) that has already shifted a
    // transcript's words onto a video overlay's timeline window starting at 2.
    const words = [w("Hi", 2.05, 2.4)];
    const cues = buildCaptionCues(words, { lead: 0.15, minStart: 2 });
    // Without minStart this would floor at 0 or land at 1.9 — must not go
    // below the overlay's own start.
    expect(cues[0].start).toBe(2);
  });

  it("minStart also floors later cues via prevEnd tracking, not just the first", () => {
    const words = [w("Hi", 2.05, 2.4), w("there", 2.5, 2.9)];
    const cues = buildCaptionCues(words, { maxCharsPerLine: 2, maxLines: 1, lead: 0.15, hold: 0, minStart: 2 });
    for (const c of cues) expect(c.start).toBeGreaterThanOrEqual(2);
  });
  // D1 / D3 (QA 2026-09-19): the previous cue's hold must never delay the
  // next cue — it is clamped to the next cue's lead-in instead.
  it("continuous speech: the next cue starts at its first word - lead, not delayed by the previous hold", () => {
    const words = [w("aaaa", 1.0, 1.4), w("bbbb", 1.45, 1.9), w("cccc", 1.95, 2.4)];
    const cues = buildCaptionCues(words, { maxCharsPerLine: 5, maxLines: 1, lead: 0.15, hold: 0.4 });
    expect(cues.map((c) => c.text)).toEqual(["aaaa", "bbbb", "cccc"]);
    // "bbbb" is spoken at 1.45; lead-in 1.30 is before "aaaa" ends (1.4), so
    // the floor is the previous cue's LAST WORD end, not its held end (1.8).
    expect(cues[1].start).toBeCloseTo(1.4, 5);
    expect(cues[2].start).toBeCloseTo(1.9, 5);
    // The held end is clamped to the next cue's start — never overlapping.
    expect(cues[0].end).toBeCloseTo(cues[1].start, 5);
    expect(cues[1].end).toBeCloseTo(cues[2].start, 5);
    // The last cue keeps its full hold.
    expect(cues[2].end).toBeCloseTo(2.8, 5);
    for (const c of cues) {
      expect(c.start).toBeLessThanOrEqual(c.words![0].start);
      expect(c.end).toBeGreaterThan(c.start);
    }
  });

  it("uses the full lead when there is a gap bigger than the lead between cues", () => {
    const words = [w("aaaa", 1.0, 1.4), w("bbbb", 2.0, 2.4)];
    const cues = buildCaptionCues(words, { maxCharsPerLine: 5, maxLines: 1, lead: 0.15, hold: 0.4 });
    expect(cues[1].start).toBeCloseTo(1.85, 5); // 2.0 - lead, not 1.8 (held end) or later
    expect(cues[0].end).toBeCloseTo(1.8, 5); // full hold fits before the lead-in
  });

  it("split at 3.5 (QA repro): the word spoken 3.20–3.58 still gets a cue, clamped to the window end", () => {
    // Head window of a split clip, words already on the timeline, window ends at 3.5.
    const words = [
      w("is", 0.1, 0.3), w("a", 0.3, 0.4), w("short", 0.36, 0.7), w("clip", 0.7, 1.0),
      w("made", 1.0, 1.3), w("for", 1.3, 1.5), w("quality", 1.5, 2.0), w("assurance.", 2.0, 2.8),
      w("The", 2.9, 3.18), w("captions", 3.2, 3.58),
    ];
    const cues = buildCaptionCues(words, { maxCharsPerLine: 26, maxLines: 2, maxEnd: 3.5, minStart: 0 });
    const all = cues.map((c) => c.text).join(" ");
    expect(all).toContain("captions");
    const last = cues[cues.length - 1];
    expect(last.text).toBe("captions");
    expect(last.start).toBeCloseTo(3.18, 5); // prev cue's last word end (lead-in 3.05 is before it)
    expect(last.end).toBeCloseTo(3.5, 5); // straddles maxEnd → ends at maxEnd
    for (let i = 1; i < cues.length; i++) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end - 1e-9);
    for (const c of cues) expect(c.end).toBeGreaterThan(c.start);
  });

  it("the final word near maxEnd shows on time, not after it has already ended", () => {
    // QA: "watching." spoken 9.74–10.04, video ends 10.272; previously shown only from 10.14.
    const words = [w("Thank", 9.2, 9.4), w("you", 9.4, 9.5), w("for", 9.5, 9.7), w("watching.", 9.74, 10.04)];
    const cues = buildCaptionCues(words, { maxCharsPerLine: 12, maxLines: 1, maxEnd: 10.272 });
    const last = cues[cues.length - 1];
    expect(last.text).toBe("watching.");
    expect(last.start).toBeLessThanOrEqual(9.74);
    expect(last.start).toBeCloseTo(9.7, 5);
    expect(last.end).toBeCloseTo(10.272, 5);
  });

  it("keeps a cue whose first word starts just before maxEnd; drops only cues starting at/after it", () => {
    const words = [w("early", 0, 0.5), w("edge", 0.95, 1.3), w("after", 1.0, 1.2)];
    // "after" overlaps oddly but starts at maxEnd → dropped; "edge" starts before → kept.
    const cues = buildCaptionCues(words, { maxCharsPerLine: 6, maxLines: 1, maxEnd: 1.0 });
    expect(cues.map((c) => c.text)).toEqual(["early", "edge"]);
    expect(cues[1].end).toBeCloseTo(1.0, 5);
    expect(cues[1].start).toBeLessThan(cues[1].end);
  });
});

describe("captionCharsPerLine — the no-wrap budget for a caption line", () => {
  it("9:16 at the 90 px cap fits 16 characters", () => expect(captionCharsPerLine(1080, 90)).toBe(16));
  it("16:9 is capped at 42", () => expect(captionCharsPerLine(1920, 59)).toBe(42));
  it("1:1 at 59 px fits 25", () => expect(captionCharsPerLine(1080, 59)).toBe(25));
  it("never below 12", () => expect(captionCharsPerLine(320, 90)).toBe(12));
});
