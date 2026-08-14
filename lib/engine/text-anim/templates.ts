/** Text-animation templates. Each returns a draw-function BODY string that
 *  destructures element-local timing from `context` and uses `progress` for
 *  pacing. Bodies flow through validateDrawFunction → createDrawFunction. */
import type { RevealParams, Align, CaptionParams, WordCaptionParams } from "./types";

const CAPTION_FONT = "700 60px Inter, system-ui, sans-serif";
const CAPTION_STROKE = "rgba(0,0,0,0.85)";
const CAPTION_HIGHLIGHT = "#ffd400";

const DEFAULT_FONT = "bold 72px Inter, system-ui, sans-serif";
const DEFAULT_COLOR = "#ffffff";

/** x-anchor expression for a given align, in element-local (rect) space. */
function anchorX(align: Align): string {
  return align === "center" ? "width / 2" : align === "right" ? "width" : "0";
}

/**
 * Classic character-by-character reveal with an optional blinking caret.
 * Reveal completes at `revealFraction` of the window; holds full text after.
 */
export function typewriter(p: RevealParams): string {
  const text = p.text;
  const font = p.font ?? DEFAULT_FONT;
  const color = p.color ?? DEFAULT_COLOR;
  const align: Align = p.align ?? "center";
  const reveal = p.revealFraction ?? 0.6;
  return `
const { ctx, width, height, time, progress } = context;
const TEXT = ${JSON.stringify(text)};
const REVEAL = ${JSON.stringify(reveal)};
const p = Math.min(1, Math.max(0, (progress || 0) / REVEAL));
const n = Math.round(p * TEXT.length);
let label = TEXT.slice(0, n);
if (n < TEXT.length && Math.floor((time || 0) * 2) % 2 === 0) label += "|";
ctx.font = ${JSON.stringify(font)};
ctx.fillStyle = ${JSON.stringify(color)};
ctx.textAlign = ${JSON.stringify(align)};
ctx.textBaseline = "middle";
ctx.fillText(label, ${anchorX(align)}, height / 2);
`.trim();
}

/**
 * Words fade + rise in one after another (staggered). Each word's opacity is
 * driven by stagger(progress, i, wordCount, overlap).
 */
export function fadeInWords(p: RevealParams & { overlap?: number }): string {
  const font = p.font ?? DEFAULT_FONT;
  const color = p.color ?? DEFAULT_COLOR;
  const align: Align = p.align ?? "center";
  const overlap = p.overlap ?? 0.5;
  const words = p.text.split(/\s+/).filter(Boolean);
  return `
const { ctx, width, height, progress } = context;
const WORDS = ${JSON.stringify(words)};
const OVERLAP = ${JSON.stringify(overlap)};
ctx.font = ${JSON.stringify(font)};
ctx.textAlign = "left";
ctx.textBaseline = "middle";
const gap = ctx.measureText(" ").width;
let total = 0;
const widths = WORDS.map(function (w) { const ww = ctx.measureText(w).width; total += ww; return ww; });
total += gap * Math.max(0, WORDS.length - 1);
let x = ${align === "center" ? "width / 2 - total / 2" : align === "right" ? "width - total" : "0"};
for (let i = 0; i < WORDS.length; i++) {
  const local = stagger(progress || 0, i, WORDS.length, OVERLAP);
  const rise = (1 - easeOutCubic(local)) * 24;
  ctx.globalAlpha = local;
  ctx.fillStyle = ${JSON.stringify(color)};
  ctx.fillText(WORDS[i], x, height / 2 + rise);
  x += widths[i] + gap;
}
ctx.globalAlpha = 1;
`.trim();
}

/**
 * Text pops in with an elastic/back overshoot, then holds. Single line.
 */
export function popScaleSpring(p: RevealParams): string {
  const font = p.font ?? DEFAULT_FONT;
  const color = p.color ?? DEFAULT_COLOR;
  const reveal = p.revealFraction ?? 0.4;
  return `
const { ctx, width, height, progress } = context;
const TEXT = ${JSON.stringify(p.text)};
const REVEAL = ${JSON.stringify(reveal)};
const p = Math.min(1, Math.max(0, (progress || 0) / REVEAL));
const s = easeOutBack(p);
ctx.save();
ctx.translate(width / 2, height / 2);
ctx.scale(s, s);
ctx.globalAlpha = Math.min(1, p * 1.5);
ctx.font = ${JSON.stringify(font)};
ctx.fillStyle = ${JSON.stringify(color)};
ctx.textAlign = "center";
ctx.textBaseline = "middle";
ctx.fillText(TEXT, 0, 0);
ctx.restore();
ctx.globalAlpha = 1;
`.trim();
}

/**
 * Lines slide up into place one after another, each clipped to its baseline.
 * Split on "\n". Good for multi-line titles / lower-third stacks.
 */
export function slideUpLines(p: RevealParams & { overlap?: number; lineHeight?: number }): string {
  const font = p.font ?? DEFAULT_FONT;
  const color = p.color ?? DEFAULT_COLOR;
  const align: Align = p.align ?? "center";
  const overlap = p.overlap ?? 0.4;
  const lineHeight = p.lineHeight ?? 84;
  const lines = p.text.split("\n");
  return `
const { ctx, width, height, progress } = context;
const LINES = ${JSON.stringify(lines)};
const LH = ${JSON.stringify(lineHeight)};
const OVERLAP = ${JSON.stringify(overlap)};
ctx.font = ${JSON.stringify(font)};
ctx.fillStyle = ${JSON.stringify(color)};
ctx.textAlign = ${JSON.stringify(align)};
ctx.textBaseline = "middle";
const x = ${anchorX(align)};
const blockTop = height / 2 - (LINES.length - 1) * LH / 2;
for (let i = 0; i < LINES.length; i++) {
  const local = easeOutCubic(stagger(progress || 0, i, LINES.length, OVERLAP));
  const y = blockTop + i * LH + (1 - local) * LH;
  ctx.globalAlpha = local;
  ctx.fillText(LINES[i], x, y);
}
ctx.globalAlpha = 1;
`.trim();
}

export interface LowerThirdParams {
  title: string;
  subtitle?: string;
  titleFont?: string;
  subtitleFont?: string;
  color?: string;
  barColor?: string;
  revealFraction?: number;
}

/**
 * A title (+ optional subtitle) bar that slides in from the left, holds, then
 * slides out near the end of the window. Readable over video via a solid bar.
 */
export function lowerThird(p: LowerThirdParams): string {
  const titleFont = p.titleFont ?? "bold 56px Inter, sans-serif";
  const subFont = p.subtitleFont ?? "400 36px Inter, sans-serif";
  const color = p.color ?? "#ffffff";
  const bar = p.barColor ?? "rgba(0,0,0,0.72)";
  const reveal = p.revealFraction ?? 0.15;
  return `
const { ctx, width, height, progress } = context;
const TITLE = ${JSON.stringify(p.title)};
const SUB = ${JSON.stringify(p.subtitle ?? "")};
const REVEAL = ${JSON.stringify(reveal)};
const pr = progress || 0;
const inP = easeOutCubic(Math.min(1, pr / REVEAL));
const outP = pr > 1 - REVEAL ? easeOutCubic((pr - (1 - REVEAL)) / REVEAL) : 0;
const slide = (1 - inP) * -width + outP * -width;
ctx.save();
ctx.translate(slide, 0);
ctx.globalAlpha = Math.max(0, inP - outP);
const barH = SUB ? 150 : 96;
const barY = height - barH - 80;
ctx.fillStyle = ${JSON.stringify(bar)};
ctx.fillRect(0, barY, width, barH);
ctx.fillStyle = ${JSON.stringify(color)};
ctx.textAlign = "left";
ctx.textBaseline = "top";
ctx.font = ${JSON.stringify(titleFont)};
ctx.fillText(TITLE, 64, barY + 22);
if (SUB) { ctx.font = ${JSON.stringify(subFont)}; ctx.fillText(SUB, 64, barY + 90); }
ctx.restore();
ctx.globalAlpha = 1;
`.trim();
}

export interface GradientSweepParams extends Omit<RevealParams, "color"> {
  /** Two+ CSS colors for the moving gradient. */
  colors?: string[];
}

/**
 * A single line filled with a linear gradient whose offset sweeps across the
 * window (a shine effect). Holds fully visible; only the gradient moves.
 */
export function gradientSweep(p: GradientSweepParams): string {
  const font = p.font ?? DEFAULT_FONT;
  const align: Align = p.align ?? "center";
  const colors = p.colors && p.colors.length >= 2 ? p.colors : ["#ffffff", "#9ca3af"];
  return `
const { ctx, width, height, progress } = context;
const TEXT = ${JSON.stringify(p.text)};
const COLORS = ${JSON.stringify(colors)};
const sweep = (progress || 0) * width * 2 - width / 2;
const g = ctx.createLinearGradient(sweep, 0, sweep + width, 0);
for (let i = 0; i < COLORS.length; i++) g.addColorStop(i / (COLORS.length - 1), COLORS[i]);
ctx.font = ${JSON.stringify(font)};
ctx.fillStyle = g;
ctx.textAlign = ${JSON.stringify(align)};
ctx.textBaseline = "middle";
ctx.fillText(TEXT, ${anchorX(align)}, height / 2);
`.trim();
}

/**
 * Subtitle renderer driven by a baked-in cue list (text + [start,end) in
 * element-local seconds). Shows the cue active at `time`; readability defaults
 * (stroke outline, bottom-safe position). When `karaoke`, the word whose slice
 * of the cue is active is highlighted.
 */
export function captionCues(p: CaptionParams): string {
  const font = p.font ?? "700 52px Inter, system-ui, sans-serif";
  const color = p.color ?? "#ffffff";
  const stroke = p.stroke ?? "rgba(0,0,0,0.85)";
  const align: Align = p.align ?? "center";
  const karaoke = p.karaoke ?? false;
  const karaokeColor = p.karaokeColor ?? "#ffd400";
  return `
const { ctx, width, height, time } = context;
const CUES = ${JSON.stringify(p.cues)};
const t = time || 0;
let cue = null;
for (let i = 0; i < CUES.length; i++) { if (t >= CUES[i].start && t < CUES[i].end) { cue = CUES[i]; break; } }
if (cue) {
  ctx.font = ${JSON.stringify(font)};
  ctx.textAlign = ${JSON.stringify(align)};
  ctx.textBaseline = "alphabetic";
  ctx.lineWidth = 8;
  ctx.strokeStyle = ${JSON.stringify(stroke)};
  ctx.lineJoin = "round";
  const x = ${anchorX(align)};
  const y = height - height * 0.12;
  ctx.strokeText(cue.text, x, y);
  ctx.fillStyle = ${JSON.stringify(color)};
  ctx.fillText(cue.text, x, y);
  if (${karaoke}) {
    const words = cue.text.split(/\\s+/).filter(Boolean);
    const frac = (t - cue.start) / Math.max(0.001, cue.end - cue.start);
    const active = Math.min(words.length - 1, Math.floor(frac * words.length));
    // re-draw the active word in the highlight color over its position
    ctx.textAlign = "left";
    let wx = ${align === "center" ? "x - ctx.measureText(cue.text).width / 2" : align === "right" ? "x - ctx.measureText(cue.text).width" : "x"};
    for (let i = 0; i < words.length; i++) {
      const w = words[i] + (i < words.length - 1 ? " " : "");
      if (i === active) { ctx.fillStyle = ${JSON.stringify(karaokeColor)}; ctx.fillText(w, wx, y); ctx.fillStyle = ${JSON.stringify(color)}; }
      wx += ctx.measureText(w).width;
    }
  }
}
`.trim();
}

// ─── Word-timing-driven caption styles ───────────────────────────────────────
// These three take the STT word array (element-local seconds) and render a
// speech-SYNCED caption. They pace off element-local `time` against each word's
// real `start`, via the cumulativeLabel / currentWord / activeWordIndex helpers
// (in DRAW_HELPERS, unit-tested in caption-logic.test.ts). Draw centered in the
// overlay rect (the caller positions the rect in the safe area).

/** Shared stroke+fill draw of one centered line, for the caption styles. */
function captionDrawLine(font: string, color: string, stroke: string): string {
  return `
  ctx.font = ${JSON.stringify(font)};
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 8;
  ctx.lineJoin = "round";
  ctx.strokeStyle = ${JSON.stringify(stroke)};
  ctx.strokeText(label, width / 2, height / 2);
  ctx.fillStyle = ${JSON.stringify(color)};
  ctx.fillText(label, width / 2, height / 2);`;
}

/**
 * **cumulative** (default) — the sentence builds up one word at a time and
 * holds. Each word appears at its spoken `start` and stays. This is the most
 * readable "follow along" caption.
 */
export function captionCumulative(p: WordCaptionParams): string {
  const font = p.font ?? CAPTION_FONT;
  const color = p.color ?? DEFAULT_COLOR;
  const stroke = p.stroke ?? CAPTION_STROKE;
  return `
const { ctx, width, height, time } = context;
const WORDS = ${JSON.stringify(p.words)};
const label = cumulativeLabel(WORDS, time || 0);
if (!label) return;
${captionDrawLine(font, color, stroke)}
`.trim();
}

/**
 * **word-by-word** — only the currently-spoken word shows, replaced as the next
 * word starts (no gaps). Punchy / kinetic.
 */
export function captionWordByWord(p: WordCaptionParams): string {
  const font = p.font ?? CAPTION_FONT;
  const color = p.color ?? DEFAULT_COLOR;
  const stroke = p.stroke ?? CAPTION_STROKE;
  return `
const { ctx, width, height, time } = context;
const WORDS = ${JSON.stringify(p.words)};
const label = currentWord(WORDS, time || 0);
if (!label) return;
${captionDrawLine(font, color, stroke)}
`.trim();
}

/**
 * **karaoke** — the full sentence is shown the whole time; the
 * currently-spoken word is emphasized in `highlightColor` as the audio
 * progresses. "Show the full sentence but emphasize words as they go."
 */
export function captionKaraoke(p: WordCaptionParams): string {
  const font = p.font ?? CAPTION_FONT;
  const color = p.color ?? DEFAULT_COLOR;
  const stroke = p.stroke ?? CAPTION_STROKE;
  const highlight = p.highlightColor ?? CAPTION_HIGHLIGHT;
  return `
const { ctx, width, height, time } = context;
const WORDS = ${JSON.stringify(p.words)};
const active = activeWordIndex(WORDS, time || 0);
ctx.font = ${JSON.stringify(font)};
ctx.textBaseline = "middle";
ctx.textAlign = "left";
ctx.lineWidth = 8;
ctx.lineJoin = "round";
ctx.strokeStyle = ${JSON.stringify(stroke)};
const parts = WORDS.map(function (w, i) { return w.text + (i < WORDS.length - 1 ? " " : ""); });
const widths = parts.map(function (s) { return ctx.measureText(s).width; });
let total = 0;
for (let i = 0; i < widths.length; i++) total += widths[i];
let x = width / 2 - total / 2;
const y = height / 2;
for (let i = 0; i < parts.length; i++) {
  ctx.strokeText(parts[i], x, y);
  ctx.fillStyle = i === active ? ${JSON.stringify(highlight)} : ${JSON.stringify(color)};
  ctx.fillText(parts[i], x, y);
  x += widths[i];
}
`.trim();
}
