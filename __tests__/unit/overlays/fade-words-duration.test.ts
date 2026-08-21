/**
 * `fade-words` must honour `reveal.durationMs`, like every other discovery mode.
 *
 * THE BUG (2026-08-20): `fadeWordsAlpha` took only `progress`, so the reveal
 * always spread across the ENTIRE overlay window and `durationMs` was ignored —
 * in the 2D renderer and the 3D one alike. It looked right for as long as every
 * caption happened to be about as long as its intended reveal. Extending the
 * onboarding piece's end card from 1.4 s to 11.4 s so it holds on screen turned
 * a 500 ms word fade into a five-second crawl, measured in rendered frames:
 * the subline's ink kept climbing until ~46 s when it should have settled by
 * 41.1 s. The npx chip, a `typewriter`, was correct throughout — typewriter had
 * always passed the fraction.
 *
 * `durationMs` is documented as authoritative in lib/engine/types.ts.
 */

import { describe, it, expect } from "vitest";
import { fadeWordsAlpha, typewriterCharCount } from "@/lib/overlays/caption-style";
import { revealFraction } from "@/lib/engine/text-anim/caption-reveal";

/** progress at a given element-local second, for an overlay of `dur` seconds. */
const at = (sec: number, dur: number) => sec / dur;

describe("fadeWordsAlpha honours the reveal fraction", () => {
  const WORDS = 5; // "Your best AI video studio"

  it("completes within durationMs on a LONG overlay", () => {
    // The end card: 500 ms reveal on an 11.4 s overlay.
    const dur = 11.4;
    const fraction = revealFraction({ durationMs: 500 }, dur);

    // Just after the reveal window, every word is fully in.
    const after = fadeWordsAlpha(WORDS, at(0.6, dur), fraction);
    expect(Math.min(...after)).toBe(1);

    // And it stays in for the whole hold — nothing still animating at 5 s.
    const holding = fadeWordsAlpha(WORDS, at(5.0, dur), fraction);
    expect(Math.min(...holding)).toBe(1);
  });

  it("is still mid-reveal partway through the window", () => {
    const dur = 11.4;
    const fraction = revealFraction({ durationMs: 500 }, dur);
    const mid = fadeWordsAlpha(WORDS, at(0.15, dur), fraction);
    expect(mid[0]).toBeGreaterThan(0);
    expect(Math.min(...mid)).toBeLessThan(1); // last words not yet arrived
  });

  it("REGRESSION: without the fraction the same reveal crawls for seconds", () => {
    // This is precisely what shipped: raw progress, so the fade spans the whole
    // overlay. With 5 words the last one only starts at progress 0.286 and
    // finishes at 0.429 — 4.89 s into an 11.4 s overlay, which matches the
    // rendered frames measured at the time (subline ink still climbing at 44 s,
    // settled by 46 s). Kept so the old behaviour cannot quietly return.
    const dur = 11.4;
    const atThreeSeconds = fadeWordsAlpha(WORDS, at(3.0, dur));
    expect(Math.min(...atThreeSeconds)).toBe(0); // last word hasn't even begun
    // …while the fixed call has been settled since 0.5 s.
    const fraction = revealFraction({ durationMs: 500 }, dur);
    expect(Math.min(...fadeWordsAlpha(WORDS, at(3.0, dur), fraction))).toBe(1);
  });

  it("is unchanged when the overlay is about as long as its reveal", () => {
    // Why this went unnoticed: at 1.4 s the fraction is ~0.36 and the visible
    // result is close either way.
    const dur = 1.4;
    const fraction = revealFraction({ durationMs: 500 }, dur);
    expect(Math.min(...fadeWordsAlpha(WORDS, at(0.6, dur), fraction))).toBe(1);
  });

  it("defaults to the full window when no fraction is given", () => {
    expect(fadeWordsAlpha(WORDS, 1)).toEqual(fadeWordsAlpha(WORDS, 1, 1));
  });

  it("matches typewriter's contract — both complete at the same instant", () => {
    const dur = 11.4;
    const fraction = revealFraction({ durationMs: 500 }, dur);
    const p = at(0.5, dur); // exactly at the end of the reveal window
    expect(Math.min(...fadeWordsAlpha(WORDS, p, fraction))).toBe(1);
    expect(typewriterCharCount(20, p, fraction)).toBe(20);
  });
});
