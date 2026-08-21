// GENERATED FILE — do not edit by hand.
// Written by scripts/extract-onboarding-piece.ts (npm run onboarding:extract)
// The draw body of overlay code-5jls8n94, hydrated out of the piece's
// per-overlay code file (composition.json never holds overlay code).
//
// Byte-for-byte the body stored in the piece EXCEPT for the
// 3 font string(s) listed below — whether set via `ctx.font` or passed
// to a helper as `{ font: … }`. Only a backtick and a `${` are escaped
// otherwise.
//
// THIS IS A DELIBERATE DIVERGENCE FROM THE SOURCE PIECE — do not diff the
// two and 'fix' it back. The piece names macOS-only families that fall
// through to a platform default on Windows and Linux; libi bundles Inter
// and JetBrains Mono so the film renders identically everywhere. The
// source piece is the user's work product and stays untouched, so the
// substitution lives here, in the emitter's map.
//
//   "500 30px Menlo, monospace" -> "500 30px \"JetBrains Mono\", monospace"
//   "500 22px Menlo, monospace" -> "500 22px \"JetBrains Mono\", monospace"
//   "500 22px Menlo, monospace" -> "500 22px \"JetBrains Mono\", monospace"
export const CODE_5JLS8N94_DRAW = `const { ctx, width: W, height: H, frame } = context;
const BG = "#0b0d12", PANEL = "#12151c", BORDER = "#232838", DIM = "#8b93a7";
ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);

const SWITCH = 70; // loader → storyboard

// ---------- phase 1: orbital loader ----------
if (frame < SWITCH + 10) {
  const fade = Math.max(0, interpolate(frame, [SWITCH - 6, SWITCH + 8], [1, 0]));
  const cx = W / 2, cy = H / 2 - 40;
  ctx.save();
  ctx.globalAlpha = fade;
  const core = 26 + Math.sin(frame / 7) * 6;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, core * 3);
  g.addColorStop(0, "rgba(129,140,248,0.9)"); g.addColorStop(0.5, "rgba(34,211,238,0.25)"); g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, core * 3, 0, Math.PI * 2); ctx.fill();
  drawCircle(ctx, cx, cy, core, "#e8eaf0");
  [[110, 0.11, "#22d3ee", 0.9], [150, -0.07, "#e879f9", 0.8], [190, 0.045, "#6366f1", 0.6]].forEach(([r, sp, col, al]) => {
    ctx.strokeStyle = col; ctx.globalAlpha = fade * al; ctx.lineWidth = 5; ctx.lineCap = "round";
    const a0 = frame * sp;
    ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + Math.PI * 1.25); ctx.stroke();
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, 7, 0, Math.PI * 2); ctx.fill();
  });
  ctx.globalAlpha = fade;
  ctx.font = '500 30px "JetBrains Mono", monospace'; ctx.fillStyle = DIM; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const pct = Math.min(100, Math.round(interpolate(frame, [0, SWITCH - 8], [0, 100])));
  ctx.fillText(\`generating keyframes… \${pct}%\`, cx, cy + 260);
  ctx.restore();
}

// ---------- phase 2: storyboard card chrome (images are overlays on top) ----------
if (frame >= SWITCH) {
  const hdrA = interpolate(frame, [SWITCH, SWITCH + 10], [0, 1]);
  ctx.globalAlpha = hdrA;
  ctx.font = "700 44px Inter, sans-serif"; ctx.fillStyle = "#e8eaf0"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("Storyboard", 140, 250);
  ctx.font = "400 26px Inter, sans-serif"; ctx.fillStyle = DIM;
  ctx.fillText("ZEPHYRON ONE — 4 keyframes", 384, 254);
  ctx.globalAlpha = 1;

  const LABELS = ["sc.01 · start", "sc.01 · end", "sc.02 · start", "sc.02 · end"];
  const cw = 380, chh = 320, gap = 40, x0 = (W - (cw * 4 + gap * 3)) / 2, y0 = 330;
  for (let i = 0; i < 4; i++) {
    const t0 = SWITCH + 8 + i * 14;
    if (frame < t0) continue;
    const s = Math.min(1, spring(frame - t0, { stiffness: 150, damping: 15 }));
    const a = interpolate(frame, [t0, t0 + 8], [0, 1]);
    const cx2 = x0 + i * (cw + gap) + cw / 2, cy2 = y0 + chh / 2;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(cx2, cy2); ctx.scale(0.92 + 0.08 * s, 0.92 + 0.08 * s); ctx.translate(-cx2, -cy2);
    ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 30; ctx.shadowOffsetY = 8;
    drawRoundedRect(ctx, x0 + i * (cw + gap), y0, cw, chh, 14, PANEL, BORDER);
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    // empty image well (the real keyframe image overlay lands exactly here)
    drawRoundedRect(ctx, x0 + i * (cw + gap) + 12, y0 + 12, cw - 24, 200, 8, "#0e1118");
    ctx.font = '500 22px "JetBrains Mono", monospace'; ctx.fillStyle = "#a5b4fc"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(LABELS[i], x0 + i * (cw + gap) + 20, y0 + 248);
    drawCircle(ctx, x0 + i * (cw + gap) + cw - 30, y0 + 248, 6, "#34d399");
    ctx.font = "500 20px Inter, sans-serif"; ctx.fillStyle = DIM;
    ctx.fillText("keyframe · gpt-image-2", x0 + i * (cw + gap) + 20, y0 + 284);
    ctx.restore();
  }
  if (frame > SWITCH + 78) {
    ctx.globalAlpha = interpolate(frame, [SWITCH + 78, SWITCH + 88], [0, 1]);
    drawRoundedRect(ctx, x0, y0 + chh + 36, 330, 46, 10, "#10241c");
    drawCircle(ctx, x0 + 24, y0 + chh + 59, 6, "#34d399");
    ctx.font = '500 22px "JetBrains Mono", monospace'; ctx.fillStyle = "#8ef0c0"; ctx.textAlign = "left";
    ctx.fillText("4 keyframes ready ✓", x0 + 44, y0 + chh + 60);
    ctx.globalAlpha = 1;
  }
}`;
