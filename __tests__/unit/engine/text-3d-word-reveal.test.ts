import { describe, it, expect } from "vitest";
import {
  wordStaggerProgress,
  glyphRevealState,
  type WordStaggerMode,
} from "@/lib/engine/text-3d/word-reveal";

// Two words ("Hello world" → wordCount 2), full-window reveal (fraction 1).
const WC = 2;
const OPTS = { fraction: 1, wordCount: WC, rise: 0.9 };

describe("wordStaggerProgress — per-word slice of the reveal window", () => {
  it("word 0 reveals over the first half, word 1 over the second", () => {
    expect(wordStaggerProgress(0, 0.0, 1, WC)).toBe(0);
    expect(wordStaggerProgress(0, 0.5, 1, WC)).toBe(1); // word 0 done at 50%
    expect(wordStaggerProgress(1, 0.5, 1, WC)).toBe(0); // word 1 not started
    expect(wordStaggerProgress(1, 1.0, 1, WC)).toBe(1); // word 1 done at 100%
  });

  it("honours `fraction` (reveal finishes earlier than the clip end)", () => {
    // fraction 0.5 ⇒ everything revealed by progress 0.5
    expect(wordStaggerProgress(1, 0.5, 0.5, WC)).toBe(1);
  });
});

const MODES: WordStaggerMode[] = ["fade-words", "slide-up", "pop"];

describe("glyphRevealState — 3D word-stagger reveal animates over time", () => {
  for (const mode of MODES) {
    it(`(${mode}) the second word is HIDDEN early and SHOWN late`, () => {
      const early = glyphRevealState(mode, 1, 0.1, OPTS);
      const late = glyphRevealState(mode, 1, 0.95, OPTS);
      expect(early.visible).toBe(false);
      expect(late.visible).toBe(true);
    });

    it(`(${mode}) all words are at rest (visible, scale 1, dy 0) at progress 1`, () => {
      for (let wi = 0; wi < WC; wi++) {
        const st = glyphRevealState(mode, wi, 1, OPTS);
        expect(st.visible).toBe(true);
        expect(st.scale).toBeCloseTo(1, 5);
        expect(st.dy).toBeCloseTo(0, 5);
      }
    });
  }

  it("(slide-up) a mid-reveal word sits BELOW its rest position (negative dy), rising to 0", () => {
    const mid = glyphRevealState("slide-up", 1, 0.6, OPTS); // word 1 partway through
    expect(mid.dy).toBeLessThan(0);
    expect(mid.scale).toBe(1);
  });

  it("(pop) a mid-reveal word overshoots past scale 1 then settles", () => {
    // ease-out-back peaks above 1 partway through; sample a point near the end of
    // word 1's window where the overshoot is present.
    const samples = [0.6, 0.7, 0.8, 0.9].map((p) => glyphRevealState("pop", 1, p, OPTS).scale);
    expect(Math.max(...samples)).toBeGreaterThan(1);
    expect(glyphRevealState("pop", 1, 1, OPTS).scale).toBeCloseTo(1, 5);
  });

  it("(fade-words) a mid-reveal word grows from 0.85 toward 1 (never hidden once started)", () => {
    const start = glyphRevealState("fade-words", 1, 0.51, OPTS); // just after word 1 starts
    expect(start.visible).toBe(true);
    expect(start.scale).toBeGreaterThanOrEqual(0.85);
    expect(start.scale).toBeLessThan(1);
  });
});
