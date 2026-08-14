import { describe, it, expect } from "vitest";
import {
  activeWordIndexByTime,
  fadeWordsAlphaByTime,
  typewriterRevealedText,
  typewriterVisibleGlyphCount,
} from "@/lib/engine/text-anim/caption-reveal";
import {
  activeWordIndex,
  typewriterRevealedText as typewriterRevealedTextLogic,
} from "@/lib/engine/text-anim/caption-logic";
import { revealToEffectIn, effectInToReveal } from "@/lib/overlays/hydrate";
import { findEffect } from "@/lib/effects/registry";
import type { TextOverlay } from "@/lib/engine/types";

describe("word-timed caption reveal (voice-synced karaoke / word-current / fade-words)", () => {
  // Uneven real speech: word 1 quick, then a pause before word 3.
  const words = [
    { text: "the", start: 0.15, end: 0.3 },
    { text: "quick", start: 0.35, end: 0.7 },
    { text: "fox", start: 1.4, end: 1.8 }, // long pause before this
  ];

  it("activeWordIndexByTime tracks the ACTUAL spoken word, not even spacing", () => {
    expect(activeWordIndexByTime(words, 0.0)).toBe(-1); // before first word
    expect(activeWordIndexByTime(words, 0.2)).toBe(0); // "the"
    expect(activeWordIndexByTime(words, 0.5)).toBe(1); // "quick"
    // During the pause (0.9s) the active word STAYS on "quick" — a linear guess
    // (floor(progress*3)) would have wrongly advanced to "fox" by now.
    expect(activeWordIndexByTime(words, 0.9)).toBe(1);
    expect(activeWordIndexByTime(words, 1.5)).toBe(2); // "fox"
  });

  it("fadeWordsAlphaByTime ramps each word in at its OWN start", () => {
    // At t=0.4: "the" fully in, "quick" just starting to ramp, "fox" not yet.
    const a = fadeWordsAlphaByTime(words, 0.4, 0.18);
    expect(a[0]).toBe(1);
    expect(a[1]).toBeGreaterThan(0);
    expect(a[1]).toBeLessThan(1);
    expect(a[2]).toBe(0);
    // At t=1.0 (mid-pause): first two fully in, "fox" still absent.
    const b = fadeWordsAlphaByTime(words, 1.0, 0.18);
    expect(b[0]).toBe(1);
    expect(b[1]).toBe(1);
    expect(b[2]).toBe(0);
  });
});

describe("single source of truth + read-ahead lead", () => {
  const words = [
    { text: "the", start: 0.15, end: 0.3 },
    { text: "quick", start: 0.35, end: 0.7 },
    { text: "fox", start: 1.4, end: 1.8 },
  ];

  it("the renderer's activeWordIndexByTime IS caption-logic.activeWordIndex (one impl, not two)", () => {
    // caption-reveal re-exports the canonical function so the declarative
    // renderer and code overlays can never drift 80ms apart again.
    expect(activeWordIndexByTime).toBe(activeWordIndex);
  });

  it("applies the ~80ms read-ahead: a word lights up just BEFORE its onset", () => {
    // "quick" starts at 0.35; at t=0.30 (50ms early) the lead (80ms) has already
    // made it active — the eye is on the word as the sound arrives.
    expect(activeWordIndexByTime(words, 0.3)).toBe(1);
    // But not TOO early: 200ms before onset it is still on the previous word.
    expect(activeWordIndexByTime(words, 0.15)).toBe(0);
  });
});

describe("typewriterRevealedText — per-word LETTER reveal (voice-synced), not linear", () => {
  const words = [
    { text: "the", start: 0.15, end: 0.3 },
    { text: "quick", start: 0.35, end: 0.7 },
    { text: "fox", start: 1.4, end: 1.8 }, // long pause before this
  ];

  it("re-exported from caption-reveal is the same impl as caption-logic", () => {
    expect(typewriterRevealedText).toBe(typewriterRevealedTextLogic);
  });

  it("shows nothing before the first word", () => {
    expect(typewriterRevealedText(words, 0)).toBe("");
  });

  it("during the pause it holds at the spoken-so-far words — NOT typing ahead into 'fox'", () => {
    // t=1.0 is between "quick" (ends 0.7) and "fox" (starts 1.4). A LINEAR
    // typewriter paced over the cue would already be spelling "fox"; the
    // voice-synced one waits.
    expect(typewriterRevealedText(words, 1.0)).toBe("the quick");
  });

  it("reveals the in-progress word letter by letter across its own window", () => {
    // "fox" spans [1.4,1.8]; at 1.6 it is ~50% through → 1–2 letters.
    const at1_6 = typewriterRevealedText(words, 1.6);
    expect(at1_6.startsWith("the quick ")).toBe(true);
    const foxPart = at1_6.slice("the quick ".length);
    expect(foxPart.length).toBeGreaterThanOrEqual(1);
    expect(foxPart.length).toBeLessThan(3);
    expect("fox".startsWith(foxPart)).toBe(true);
  });

  it("shows the full caption once every word is spoken", () => {
    expect(typewriterRevealedText(words, 2.5)).toBe("the quick fox");
  });

  it("typewriterVisibleGlyphCount counts non-space revealed glyphs", () => {
    // "the quick" → 8 non-space glyphs.
    expect(typewriterVisibleGlyphCount(words, 1.0)).toBe(8);
    expect(typewriterVisibleGlyphCount(words, 0)).toBe(0);
  });
});

describe("karaoke / word-current reveal ↔ effects.in bridge (Issue B)", () => {
  const base = {
    id: "c1",
    kind: "text" as const,
    startTime: 0,
    duration: 2,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    z: 0,
    content: "hi",
    font: "24px Inter",
    color: "#fff",
    align: "center" as const,
  };

  it("a karaoke reveal surfaces as an applied effects.in the inspector can resolve", () => {
    const overlay = { ...base, reveal: { mode: "karaoke" as const } } as TextOverlay;
    const withEffect = revealToEffectIn(overlay);
    expect((withEffect as TextOverlay).effects?.in?.effectId).toBe("karaoke");
    // The inspector renders applied effects via findEffect(effectId) — it must resolve.
    expect(findEffect("karaoke")).toBeTruthy();
    expect(findEffect("word-current")).toBeTruthy();
  });

  it("round-trips: effects.in karaoke → reveal karaoke", () => {
    const overlay = { ...base, effects: { in: { effectId: "karaoke" } } } as unknown as TextOverlay;
    const withReveal = effectInToReveal(overlay);
    expect((withReveal as TextOverlay).reveal?.mode).toBe("karaoke");
  });
});
