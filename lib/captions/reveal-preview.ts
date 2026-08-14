/** Short sample phrase used by the Reveal card hover preview. */
export const REVEAL_SAMPLE_WORDS = ["Make", "it", "pop"];

export interface RevealWordViz {
  opacity: number; // 0..1
  translateYPx: number; // vertical offset (slide-style modes)
  highlighted: boolean; // karaoke active word
  visible: boolean; // word-current: only active rendered
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Per-word visual state for a reveal `mode` at progress `p` (0..1), driving the
 * Reveal card hover preview. Word-based modes only; typewriter reveals at the
 * character level (see `revealTypewriterCount`). `flythrough` is approximated as
 * a staggered fade (the real 3D fly-in renders on the canvas).
 */
export function revealWordStates(
  mode: string,
  p: number,
  wordCount = REVEAL_SAMPLE_WORDS.length,
): RevealWordViz[] {
  const n = Math.max(1, wordCount);
  const active = Math.min(n - 1, Math.floor(clamp01(p) * n));
  const out: RevealWordViz[] = [];
  for (let i = 0; i < n; i++) {
    const stagger = 1 / n;
    const local = clamp01((p - i * stagger) / Math.max(stagger, 1e-4));
    switch (mode) {
      case "fade-words":
      case "flythrough":
        out.push({ opacity: local, translateYPx: 0, highlighted: false, visible: true });
        break;
      case "slide-up":
        out.push({ opacity: local, translateYPx: (1 - local) * 8, highlighted: false, visible: true });
        break;
      case "karaoke":
        out.push({
          opacity: i === active ? 1 : 0.45,
          translateYPx: 0,
          highlighted: i === active,
          visible: true,
        });
        break;
      case "word-current":
        out.push({ opacity: i === active ? 1 : 0, translateYPx: 0, highlighted: false, visible: i === active });
        break;
      case "none":
      default:
        out.push({ opacity: 1, translateYPx: 0, highlighted: false, visible: true });
    }
  }
  return out;
}

/** Characters of a `textLength`-long string revealed at progress `p` — typewriter. */
export function revealTypewriterCount(p: number, textLength: number): number {
  return Math.round(clamp01(p) * textLength);
}
