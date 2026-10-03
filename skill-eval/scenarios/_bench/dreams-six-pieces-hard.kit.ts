/**
 * Generated code bodies for `_bench/dreams-six-pieces-hard.md`: the per-piece "style kit" end card
 * (~190 lines of palette + helpers + a scene, different in every piece) and the caption body that
 * bakes its word timings in COMPOSITION seconds. Pure string builders, no I/O — the hooks module
 * seeds them, and its verify hook runs the same text again to read what a body draws.
 *
 * Why these shapes (docs-local/research/2026-10-03-dreams-session-analysis.md §P2, §P4):
 *  - the real session's captions carried `NARRATION_OFFSET = 8.3` and a code body per piece
 *    that an agent had to read, patch with `sed`, and re-render;
 *  - each end card was drawn "in the piece's style" by reading 100–300 line kits whose helper
 *    sets differ, so reading one sibling's kit teaches nothing about another's.
 */

/** The narration's word timings in SECONDS FROM THE FILE's start (jfk.wav, 11 s). Approximate to the audio (silence-detect bounded); the benchmark's truth is these numbers, not the waveform. */
export const WORDS: ReadonlyArray<readonly [number, number, string]> = [
  [0.33, 0.62, "And"],
  [0.62, 0.95, "so"],
  [1.1, 1.35, "my"],
  [1.35, 1.78, "fellow"],
  [1.78, 2.18, "Americans"],
  [3.29, 3.8, "ask"],
  [3.95, 4.43, "not"],
  [4.91, 5.19, "what"],
  [5.41, 5.7, "your"],
  [5.7, 6.3, "country"],
  [6.3, 6.55, "can"],
  [6.55, 6.8, "do"],
  [6.8, 7.05, "for"],
  [7.05, 7.87, "you"],
  [8.19, 8.6, "ask"],
  [8.6, 8.9, "what"],
  [8.9, 9.15, "you"],
  [9.15, 9.45, "can"],
  [9.45, 9.7, "do"],
  [9.7, 9.95, "for"],
  [9.95, 10.25, "your"],
  [10.25, 10.95, "country"],
];

export interface Palette {
  bg: string;
  ink: string;
  accent: string;
  accent2: string;
  muted: string;
}

export interface KitStyle {
  name: string;
  palette: Palette;
  font: { display: string; body: string };
  /** The caption's look (a code body, so it carries its own colours). */
  caption: { color: string; stroke: string; weight: number; family: string };
  /** The helper functions this style's kit defines (a different five each). */
  helpers: readonly string[];
  /** `drawBackdrop()`'s body. */
  backdrop: string;
  /** Statements run after the backdrop, before the title. */
  scene: string;
}

/** Common block every kit opens with after its palette (≈ 35 lines). */
const COMMON = `const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const smoothInOut = (t) => {
  t = clamp(t, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
const rand = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function mix(c1, c2, t) {
  const a = hexToRgb(c1);
  const b = hexToRgb(c2);
  return 'rgb(' + Math.round(lerp(a[0], b[0], t)) + ',' + Math.round(lerp(a[1], b[1], t)) + ',' + Math.round(lerp(a[2], b[2], t)) + ')';
}
function withAlpha(a, fn) {
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * clamp(a, 0, 1);
  fn();
  ctx.globalAlpha = prev;
}
function rrect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
function vignette(strength) {
  const g = ctx.createRadialGradient(W / 2, H / 2, W * 0.3, W / 2, H / 2, H * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,' + strength + ')');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}
function divider(y, color, widthPct) {
  const w = W * widthPct;
  ctx.fillStyle = color;
  ctx.fillRect((W - w) / 2, y, w, 3);
}
function badge(str, x, y, color, ink) {
  ctx.font = '700 ' + Math.round(W * 0.034) + 'px ' + FONT.body;
  const w = ctx.measureText(str).width + 48;
  ctx.fillStyle = color;
  rrect(x - w / 2, y - 30, w, 60, 30);
  ctx.fill();
  textAt(str, x, y, W * 0.034, ink, '700', FONT.body, 'center');
}
function textAt(str, x, y, size, color, weight, family, align) {
  ctx.font = weight + ' ' + Math.round(size) + 'px ' + family;
  ctx.fillStyle = color;
  ctx.textAlign = align || 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(str, x, y);
}`;

/** Every helper a kit may define. Each style picks five; the names differ between pieces. */
const HELPERS: Record<string, string> = {
  glow: `function glow(color, blur, fn) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  fn();
  ctx.restore();
}`,
  scanlines: `function scanlines(alpha, gap) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,' + alpha + ')';
  for (let y = 0; y < H; y += gap) ctx.fillRect(0, y, W, 1);
  ctx.restore();
}`,
  gridFloor: `function gridFloor(horizonY, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  for (let i = -10; i <= 10; i++) {
    ctx.beginPath();
    ctx.moveTo(W / 2 + i * 20, horizonY);
    ctx.lineTo(W / 2 + i * 220, H);
    ctx.stroke();
  }
  for (let j = 1; j < 9; j++) {
    const y = horizonY + Math.pow(j / 9, 2) * (H - horizonY);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.restore();
}`,
  stars: `function stars(count, color, maxY) {
  ctx.save();
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const tw = 0.4 + 0.6 * Math.abs(Math.sin(time * 2 + i));
    ctx.globalAlpha = tw;
    const s = 2 + rand(i + 9) * 4;
    ctx.fillRect(rand(i) * W, rand(i + 50) * maxY, s, s);
  }
  ctx.restore();
}`,
  ring: `function ring(cx, cy, r, color, width, sweep) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(sweep, 0, 1));
  ctx.stroke();
  ctx.restore();
}`,
  grain: `function grain(amount) {
  ctx.save();
  for (let i = 0; i < 900; i++) {
    const a = rand(i + Math.floor(time * 12)) * amount;
    ctx.fillStyle = 'rgba(60,40,20,' + a.toFixed(3) + ')';
    ctx.fillRect(rand(i * 3) * W, rand(i * 7) * H, 3, 3);
  }
  ctx.restore();
}`,
  tornEdge: `function tornEdge(y, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, y);
  for (let x = 0; x <= W; x += 24) ctx.lineTo(x, y + (rand(x) - 0.5) * 28);
  ctx.lineTo(W, y + 600);
  ctx.lineTo(0, y + 600);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}`,
  stamp: `function stamp(label, x, y, size, color, angle) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.strokeStyle = color;
  ctx.lineWidth = 6;
  rrect(-size * 2.2, -size * 0.8, size * 4.4, size * 1.6, 14);
  ctx.stroke();
  textAt(label, 0, 0, size, color, '800', FONT.body, 'center');
  ctx.restore();
}`,
  marquee: `function marquee(y, text, size, color) {
  ctx.save();
  ctx.font = '700 ' + size + 'px ' + FONT.body;
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 80;
  const off = (time * 140) % w;
  for (let x = -off; x < W; x += w) ctx.fillText(text, x, y);
  ctx.restore();
}`,
  sparkle: `function sparkle(x, y, r, color, phase) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(phase);
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const rr = i % 2 === 0 ? r : r * 0.3;
    ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}`,
  brushedMetal: `function brushedMetal(x, y, w, h) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, P.muted);
  g.addColorStop(0.5, P.accent);
  g.addColorStop(1, P.muted);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = P.ink;
  for (let i = 0; i < 120; i++) ctx.fillRect(x, y + rand(i) * h, w, 1);
  ctx.restore();
}`,
  sweep: `function sweep(t, color) {
  const x = lerp(-W * 0.3, W * 1.3, smoothInOut(t));
  ctx.save();
  const g = ctx.createLinearGradient(x - 140, 0, x + 140, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, color);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.globalAlpha = 0.35;
  ctx.fillRect(x - 140, 0, 280, H);
  ctx.restore();
}`,
  bevelText: `function bevelText(str, x, y, size, light, dark) {
  textAt(str, x + 3, y + 3, size, dark, '800', FONT.display, 'center');
  textAt(str, x - 2, y - 2, size, light, '800', FONT.display, 'center');
}`,
  crosshair: `function crosshair(cx, cy, r, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx, cy + r);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}`,
  sunDisc: `function sunDisc(cx, cy, r) {
  const g = ctx.createLinearGradient(0, cy - r, 0, cy + r);
  g.addColorStop(0, P.accent2);
  g.addColorStop(1, P.accent);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = P.bg;
  for (let i = 0; i < 6; i++) ctx.fillRect(cx - r, cy + r * 0.1 + i * r * 0.16, r * 2, 2 + i * 2);
}`,
  horizonBands: `function horizonBands(y, count) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = mix(P.bg, P.muted, i / count);
    ctx.fillRect(0, y + i * 26, W, 26);
  }
}`,
  confetti: `function confetti(count, colors) {
  ctx.save();
  for (let i = 0; i < count; i++) {
    const fall = (time * (60 + rand(i) * 80) + rand(i + 3) * H) % H;
    ctx.save();
    ctx.fillStyle = colors[i % colors.length];
    ctx.translate(rand(i + 11) * W, fall);
    ctx.rotate(time * 2 + i);
    ctx.fillRect(-7, -3, 14, 6);
    ctx.restore();
  }
  ctx.restore();
}`,
  halftone: `function halftone(cx, cy, r, color) {
  ctx.save();
  ctx.fillStyle = color;
  for (let y = -r; y <= r; y += 22) {
    for (let x = -r; x <= r; x += 22) {
      const d = Math.sqrt(x * x + y * y);
      if (d > r) continue;
      ctx.beginPath();
      ctx.arc(cx + x, cy + y, 9 * (1 - d / r), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}`,
  blob: `function blob(cx, cy, r, color, seed) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const rr = r * (0.82 + 0.18 * Math.sin(a * 3 + seed + time));
    ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}`,
  heart: `function heart(cx, cy, s, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * 0.9);
  ctx.bezierCurveTo(cx - s * 1.6, cy - s * 0.2, cx - s * 0.7, cy - s * 1.3, cx, cy - s * 0.4);
  ctx.bezierCurveTo(cx + s * 0.7, cy - s * 1.3, cx + s * 1.6, cy - s * 0.2, cx, cy + s * 0.9);
  ctx.fill();
  ctx.restore();
}`,
};

export const KIT_STYLES: readonly KitStyle[] = [
  {
    name: "01 Neon",
    palette: { bg: "#0A0A12", ink: "#E8FFE8", accent: "#39FF14", accent2: "#FF2BD6", muted: "#2A2A44" },
    font: { display: "'Courier New', monospace", body: "Arial, sans-serif" },
    caption: { color: "#39FF14", stroke: "#0A0A12", weight: 800, family: "'Courier New', monospace" },
    helpers: ["glow", "scanlines", "gridFloor", "stars", "ring", "crosshair"],
    backdrop: `ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, P.bg);
  g.addColorStop(1, mix(P.bg, P.muted, 0.8));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  stars(60, P.ink, H * 0.5);`,
    scene: `gridFloor(H * 0.62, mix(P.bg, P.accent2, 0.6));
glow(P.accent, 30, () => ring(W / 2, H * 0.3, W * 0.18, P.accent, 8, smoothOut(progress * 2)));
scanlines(0.18, 4);`,
  },
  {
    name: "02 Paper",
    palette: { bg: "#F4EBDD", ink: "#1F2A44", accent: "#C8553D", accent2: "#588B8B", muted: "#B8A99A" },
    font: { display: "Georgia, serif", body: "Georgia, serif" },
    caption: { color: "#1F2A44", stroke: "#F4EBDD", weight: 700, family: "Georgia, serif" },
    helpers: ["grain", "tornEdge", "stamp", "marquee", "sparkle", "ring"],
    backdrop: `ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, W, H);
  tornEdge(H * 0.72, P.muted);
  tornEdge(H * 0.76, P.accent2);
  grain(0.12);`,
    scene: `marquee(H * 0.1, 'TIDEWATER LIGHTS  *  TIDEWATER LIGHTS  *  ', 44, P.muted);
stamp('OUT NOW', W * 0.5, H * 0.66, W * 0.06, P.accent, -0.08);
sparkle(W * 0.18, H * 0.3, 40, P.accent2, time);
sparkle(W * 0.84, H * 0.38, 26, P.accent, -time);`,
  },
  {
    name: "03 Chrome",
    palette: { bg: "#14181F", ink: "#E4E8EE", accent: "#C0C7D1", accent2: "#7FB2FF", muted: "#3A4350" },
    font: { display: "'Arial Black', Arial, sans-serif", body: "Arial, sans-serif" },
    caption: { color: "#C0C7D1", stroke: "#14181F", weight: 900, family: "'Arial Black', Arial, sans-serif" },
    helpers: ["brushedMetal", "sweep", "bevelText", "ring", "crosshair", "marquee"],
    backdrop: `ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, W, H);
  brushedMetal(W * 0.08, H * 0.2, W * 0.84, H * 0.5);
  ctx.strokeStyle = P.ink;
  ctx.lineWidth = 3;
  rrect(W * 0.08, H * 0.2, W * 0.84, H * 0.5, 22);
  ctx.stroke();`,
    scene: `ring(W * 0.5, H * 0.14, W * 0.07, P.accent2, 6, smoothOut(progress * 2));
crosshair(W * 0.5, H * 0.14, W * 0.07, P.ink);
sweep(clamp(progress * 1.4, 0, 1), P.ink);`,
  },
  {
    name: "04 Sunset",
    palette: { bg: "#2B0F2E", ink: "#FFF1E0", accent: "#FF7A45", accent2: "#FFC857", muted: "#6B2D5C" },
    font: { display: "Georgia, serif", body: "'Trebuchet MS', sans-serif" },
    caption: { color: "#FF7A45", stroke: "#2B0F2E", weight: 800, family: "Georgia, serif" },
    helpers: ["sunDisc", "horizonBands", "stars", "glow", "confetti", "ring"],
    backdrop: `const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, P.bg);
  g.addColorStop(0.6, P.muted);
  g.addColorStop(1, P.accent);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  stars(40, P.ink, H * 0.4);
  horizonBands(H * 0.64, 12);`,
    scene: `glow(P.accent2, 50, () => sunDisc(W / 2, H * 0.3, W * 0.2));
confetti(24, [P.accent, P.accent2, P.ink]);`,
  },
  {
    name: "05 Mono",
    palette: { bg: "#000000", ink: "#FFFFFF", accent: "#D9D9D9", accent2: "#8C8C8C", muted: "#333333" },
    font: { display: "'Courier New', monospace", body: "'Courier New', monospace" },
    caption: { color: "#FFFFFF", stroke: "#000000", weight: 700, family: "'Courier New', monospace" },
    helpers: ["halftone", "crosshair", "marquee", "scanlines", "stamp", "ring"],
    backdrop: `ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, W, H);
  halftone(W * 0.5, H * 0.3, W * 0.4, P.muted);
  crosshair(W * 0.5, H * 0.3, W * 0.3, P.accent2);`,
    scene: `marquee(H * 0.9, 'LISTEN  /  LISTEN  /  LISTEN  /  ', 40, P.accent2);
stamp('NEW', W * 0.2, H * 0.12, W * 0.04, P.ink, 0.05);
scanlines(0.25, 3);`,
  },
  {
    name: "06 Pastel",
    palette: { bg: "#FFF4F8", ink: "#4A3B52", accent: "#F5B8D1", accent2: "#B8E0F5", muted: "#E8D5E0" },
    font: { display: "'Trebuchet MS', sans-serif", body: "'Trebuchet MS', sans-serif" },
    caption: { color: "#F5B8D1", stroke: "#4A3B52", weight: 800, family: "'Trebuchet MS', sans-serif" },
    helpers: ["blob", "sparkle", "heart", "confetti", "ring", "stars"],
    backdrop: `ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, W, H);
  blob(W * 0.2, H * 0.2, W * 0.35, P.accent2, 0);
  blob(W * 0.85, H * 0.6, W * 0.4, P.accent, 2);
  blob(W * 0.3, H * 0.85, W * 0.3, P.muted, 4);`,
    scene: `heart(W * 0.5, H * 0.3, W * 0.1, P.accent);
sparkle(W * 0.24, H * 0.36, 34, P.ink, time);
sparkle(W * 0.78, H * 0.26, 24, P.accent2, -time);
confetti(18, [P.accent, P.accent2, P.muted]);
ring(W * 0.5, H * 0.3, W * 0.2, P.ink, 4, smoothOut(progress * 2));`,
  },
];

const q = (s: string) => JSON.stringify(s);

/** The end card: palette + fonts + common helpers + this style's five + backdrop + scene (≈ 190 lines). */
export function endCardBody(style: KitStyle): string {
  const p = style.palette;
  const helpers = style.helpers.map((h) => HELPERS[h]);
  return `// Style kit: ${style.name}. Palette, fonts and helpers first, the scene last.
const { ctx, width: W, height: H, time, progress } = context;

const P = {
  bg: ${q(p.bg)},
  ink: ${q(p.ink)},
  accent: ${q(p.accent)},
  accent2: ${q(p.accent2)},
  muted: ${q(p.muted)},
};
const FONT = {
  display: ${q(style.font.display)},
  body: ${q(style.font.body)},
};
const LAYOUT = {
  titleY: 0.46,
  subY: 0.53,
  footerY: 0.94,
  titleSize: 0.105,
  subSize: 0.05,
  enterSpeed: 3,
  leaveFrom: 0.9,
};

// ---- common helpers ----
${COMMON}

// ---- ${style.name} helpers ----
${helpers.join("\n")}

function drawBackdrop() {
  ${style.backdrop}
}

// ---- scene ----
const enter = smoothOut(progress * LAYOUT.enterSpeed);
const leave = 1 - clamp((progress - LAYOUT.leaveFrom) * 10, 0, 1);
drawBackdrop();
${style.scene}
vignette(0.25);
withAlpha(enter * leave, () => {
  textAt('Tidewater Lights', W / 2, H * LAYOUT.titleY, W * LAYOUT.titleSize, P.ink, '800', FONT.display, 'center');
  divider(H * (LAYOUT.titleY + 0.035), P.accent, 0.3 * enter);
  textAt('The Bench Band', W / 2, H * LAYOUT.subY, W * LAYOUT.subSize, P.accent, '500', FONT.body, 'center');
  badge('OUT NOW', W / 2, H * LAYOUT.footerY, P.accent, P.bg);
});
`;
}

/**
 * The caption: one word at a time, on a FULL-LENGTH overlay (it starts at 0, so its `time` IS
 * composition time). The narration's composition start is baked in as `NARRATION_OFFSET` (the real
 * session's `NARRATION_OFFSET = 8.3`) and the cue hides at a baked `HIDE_AFTER`. Move the narration
 * and the overlay stays at 0, so the words lag by the move: both constants have to change (or the
 * body has to be rewritten against something that knows where the narration is).
 */
export function captionBody(style: KitStyle, narrationStart: number, narrationEnd: number): string {
  const words = WORDS.map(([s, e, w]) => `  [${s.toFixed(2)}, ${e.toFixed(2)}, ${q(w)}],`).join("\n");
  const c = style.caption;
  return `// Karaoke caption for the narration: one word at a time.
// This overlay spans the whole piece, so \`time\` is composition time (seconds).
const { ctx, width: W, height: H, time } = context;

// [start, end, text], seconds from the START of the narration.
const WORDS = [
${words}
];
const NARRATION_OFFSET = ${narrationStart.toFixed(2)}; // composition seconds: where the narration starts
const HIDE_AFTER = ${(narrationEnd + 0.1).toFixed(2)}; // composition seconds: the caption goes away after the narration
const t = time - NARRATION_OFFSET;
if (time > HIDE_AFTER) return;

let i = -1;
for (let k = 0; k < WORDS.length; k++) {
  if (t >= WORDS[k][0] && t < WORDS[k][1]) { i = k; break; }
}
if (i < 0) return;

const text = WORDS[i][2];
const age = Math.min(1, (t - WORDS[i][0]) / 0.12);
const pop = 0.85 + 0.15 * (1 - Math.pow(1 - age, 3));
const size = Math.round(W * 0.13 * pop);
ctx.font = '${c.weight} ' + size + 'px ${c.family.replace(/'/g, "\\'")}';
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.lineJoin = 'round';
ctx.lineWidth = Math.round(size * 0.12);
ctx.strokeStyle = ${q(c.stroke)};
ctx.strokeText(text, W / 2, H * 0.78);
ctx.fillStyle = ${q(c.color)};
ctx.fillText(text, W / 2, H * 0.78);
`;
}
