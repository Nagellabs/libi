/** Pure caption-styling helpers — font composition, word-wrap, and reveal math.
 *
 *  Canvas-free and DOM-free: word-wrap takes an injected `measure` callback so
 *  the same logic unit-tests without a browser. Reveal helpers pace off the
 *  element-local `progress` (0→1) the overlay renderer already provides — same
 *  contract as lib/engine/text-anim/templates.ts. */

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/** Back/overshoot easing — settles to exactly 1 at t=1, overshoots near the end. */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

/** Parse a CSS `font` shorthand into its size (px) and family token.
 *  Best-effort: looks for a `<n>px` token for size and takes the trailing
 *  run after the size as the family. */
function parseFont(font: string): { size: number | null; family: string | null } {
  const sizeMatch = font.match(/(\d+(?:\.\d+)?)px/);
  const size = sizeMatch ? parseFloat(sizeMatch[1]) : null;
  let family: string | null = null;
  if (sizeMatch) {
    const after = font.slice((sizeMatch.index ?? 0) + sizeMatch[0].length).trim();
    family = after.length > 0 ? after : null;
  } else {
    // No size token — treat the whole (non-numeric) string as a family name.
    const trimmed = font.trim();
    family = trimmed.length > 0 ? trimmed : null;
  }
  return { size, family };
}

/**
 * Compose a CSS `font` string from structured fields. If none of
 * fontFamily/fontSize/fontWeight is set, returns `o.font` unchanged.
 * Otherwise composes `"<weight> <size>px <family>"`, filling unset fields
 * from the existing `font` (or sane defaults: weight 400, size 48, family
 * "Inter").
 */
export function composeFont(o: {
  font: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number | string;
}): string {
  const hasStructured =
    o.fontFamily !== undefined || o.fontSize !== undefined || o.fontWeight !== undefined;
  if (!hasStructured) return o.font;

  const parsed = parseFont(o.font ?? "");
  const weight = o.fontWeight ?? 400;
  const size = o.fontSize ?? parsed.size ?? 48;
  const family = o.fontFamily ?? parsed.family ?? "Inter";
  return `${weight} ${size}px ${family}`;
}

/**
 * Greedy word-wrap. Respects explicit `\n` as hard breaks. A single word
 * longer than `maxWidth` occupies its own line (never produces an empty
 * leading line). `measure` returns the rendered width of a string.
 */
export function wrapText(
  measure: (s: string) => number,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  const segments = text.split("\n");
  for (const segment of segments) {
    const words = segment.split(/\s+/).filter(Boolean);
    let current = "";
    for (const word of words) {
      if (current === "") {
        current = word;
        continue;
      }
      const candidate = `${current} ${word}`;
      if (measure(candidate) <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current !== "") lines.push(current);
  }
  return lines;
}

/**
 * Number of characters revealed for a typewriter effect. 0 at progress 0,
 * `fullLen` at progress ≥ `fraction` (default 0.6). Monotonic non-decreasing.
 */
export function typewriterCharCount(
  fullLen: number,
  progress: number,
  fraction: number = 0.6,
): number {
  const f = fraction > 0 ? fraction : 0.6;
  const local = clamp01(clamp01(progress) / f);
  const n = Math.round(local * fullLen);
  return Math.min(fullLen, Math.max(0, n));
}

/**
 * Per-word alpha for a staggered fade-in. All ~0 at progress 0, all 1 once the
 * reveal window has elapsed. Earlier words lead later ones.
 *
 * `fraction` is the portion of the element's window the reveal occupies — the
 * same contract `typewriterCharCount` above uses, derived from
 * `reveal.durationMs` by `revealFraction`. Without it a 500 ms fade-words
 * reveal silently stretched to fill the WHOLE overlay: correct-looking on a
 * 1.4 s caption, and a 5-second crawl once that same overlay was extended to
 * 11.4 s to hold an end card on screen. `durationMs` is documented as
 * authoritative, and typewriter already honoured it — fade-words was the one
 * mode that did not, in both the 2D and 3D renderers.
 */
export function fadeWordsAlpha(
  wordCount: number,
  progress: number,
  fraction: number = 1,
): number[] {
  const out: number[] = [];
  if (wordCount <= 0) return out;
  const f = fraction > 0 ? fraction : 1;
  const p = clamp01(clamp01(progress) / f);
  // Overlapping stagger: each word gets a window; with overlap the windows
  // share span so the last word still reaches 1 at p=1.
  const overlap = 0.5;
  const span = 1 / (wordCount + (wordCount - 1) * overlap || 1);
  const step = span * (1 - overlap);
  for (let i = 0; i < wordCount; i++) {
    if (p >= 1) {
      out.push(1);
      continue;
    }
    const start = i * step;
    const local = clamp01((p - start) / Math.max(1e-6, span));
    out.push(clamp01(local));
  }
  return out;
}

/**
 * Per-line vertical offset (px) for a slide-up reveal. Decreases to 0 by
 * progress 1; later lines lag earlier ones at the same progress.
 */
export function slideUpOffset(
  lineIndex: number,
  lineCount: number,
  progress: number,
  lineHeightPx: number,
): number {
  const p = clamp01(progress);
  const overlap = 0.5;
  const count = Math.max(1, lineCount);
  const span = 1 / (count + (count - 1) * overlap);
  const step = span * (1 - overlap);
  const start = lineIndex * step;
  const local = p >= 1 ? 1 : clamp01((p - start) / Math.max(1e-6, span));
  return (1 - easeOutCubic(local)) * lineHeightPx;
}

/**
 * Pop/spring scale. Overshoots above 1 mid-reveal, settles to exactly 1 at
 * progress 1, starts small at progress 0.
 */
export function popScale(progress: number): number {
  const p = clamp01(progress);
  return easeOutBack(p);
}
