/** Pure per-word stagger reveal math for 3D extruded captions.
 *
 *  The three modes `fade-words` / `slide-up` / `pop` reveal a caption WORD BY WORD
 *  (cumulative — earlier words stay revealed) over the `[0, fraction]` window. The
 *  visual is expressed purely as per-glyph transform (`visible` / uniform `scale` /
 *  vertical offset `dy`) so the 3D builder can apply it WITHOUT touching glyph
 *  materials (which may be shared/cached across glyphs). Keeping the math here makes
 *  it directly unit-testable without standing up a three.js scene. */

export type WordStaggerMode = "fade-words" | "slide-up" | "pop";

export interface GlyphRevealState {
  /** Whether this glyph is shown this frame. */
  visible: boolean;
  /** Uniform scale to apply to the glyph (1 = rest). */
  scale: number;
  /** Vertical offset to ADD to the glyph's rest Y (0 = rest). */
  dy: number;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const easeOutCubic = (x: number): number => 1 - Math.pow(1 - x, 3);
const easeOutBack = (x: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

/** Local 0→1 reveal progress for `wordIndex`, given the overall element progress.
 *  Each word owns an equal slice of the `[0, fraction]` window; words reveal in
 *  order and a word stays at 1 once its slice completes. */
export function wordStaggerProgress(
  wordIndex: number,
  progress: number,
  fraction: number,
  wordCount: number,
): number {
  const frac = fraction > 0 ? fraction : 1;
  const eff = Math.min(1, progress / frac);
  const denom = Math.max(1, wordCount);
  const span = 1 / denom;
  return clamp01((eff - wordIndex * span) / span);
}

/** Per-glyph transform state for a word-stagger reveal at the given progress.
 *  - `fade-words`: soft grow-in (0.85→1) standing in for an alpha fade.
 *  - `slide-up`: rises from `-rise` to rest with an ease-out.
 *  - `pop`: scales 0→1 with an ease-out-back overshoot. */
export function glyphRevealState(
  mode: WordStaggerMode,
  wordIndex: number,
  progress: number,
  opts: { fraction: number; wordCount: number; rise: number },
): GlyphRevealState {
  const wp = wordStaggerProgress(wordIndex, progress, opts.fraction, opts.wordCount);
  if (mode === "slide-up") {
    return { visible: wp > 0, scale: 1, dy: -opts.rise * (1 - easeOutCubic(wp)) };
  }
  if (mode === "pop") {
    return { visible: wp > 0, scale: wp <= 0 ? 0 : Math.max(0, easeOutBack(wp)), dy: 0 };
  }
  // fade-words
  return { visible: wp > 0, scale: wp <= 0 ? 1 : 0.85 + 0.15 * easeOutCubic(wp), dy: 0 };
}
