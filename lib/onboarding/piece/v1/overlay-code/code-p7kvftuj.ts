// GENERATED FILE — do not edit by hand.
// Written by scripts/extract-onboarding-piece.ts (npm run onboarding:extract)
// The draw body of overlay code-p7kvftuj, hydrated out of the piece's
// per-overlay code file (composition.json never holds overlay code).
//
// Byte-for-byte the body stored in the piece EXCEPT for the
// 1 font string(s) listed below — whether set via `ctx.font` or passed
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
//   "500 21px Menlo, monospace" -> "500 21px \"JetBrains Mono\", monospace"
export const CODE_P7KVFTUJ_DRAW = `const { ctx, width: W, height: H, frame } = context;
const BG = "#0b0d12", PANEL = "#12151c", BORDER = "#232838", TEXT = "#e8eaf0", DIM = "#8b93a7";
ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);

// ---- left: agent chat panel ----
const chatX = 40, chatY = 40, chatW = 620, chatH = H - 300;
drawRoundedRect(ctx, chatX, chatY, chatW, chatH, 16, PANEL, BORDER);
ctx.font = "600 22px Inter, sans-serif"; ctx.fillStyle = DIM; ctx.textAlign = "left"; ctx.textBaseline = "middle";
ctx.fillText("agent", chatX + 28, chatY + 34);
const STEPS = [
  ["msg", "Building your launch film…"],
  ["tool", "libi.create_piece"],
  ["tool", "libi.add_storyboard_card ×2"],
  ["tool", "gpt-image-2 → keyframes"],
  ["tool", "seedance → hero orbit"],
  ["tool", "seedance → water impact"],
  ["tool", "libi.add_overlay (title)"],
  ["msg", "Placing scenes on the timeline…"],
  ["done", "2 clips · 3 overlays · audio linked"]
];
STEPS.forEach((s, i) => {
  const t0 = 6 + i * 18;
  if (frame < t0) return;
  const a = interpolate(frame, [t0, t0 + 8], [0, 1]);
  const slide = interpolate(frame, [t0, t0 + 8], [16, 0], { easing: easeOutCubic });
  const y = chatY + 70 + i * 58 + slide;
  ctx.globalAlpha = a;
  if (s[0] === "tool") {
    drawRoundedRect(ctx, chatX + 24, y, 420, 42, 10, "#0e1118", "#2b3247");
    drawCircle(ctx, chatX + 46, y + 21, 5, "#22d3ee");
    ctx.font = '500 21px "JetBrains Mono", monospace'; ctx.fillStyle = "#a5b4fc";
    ctx.fillText(s[1], chatX + 62, y + 22);
  } else {
    drawRoundedRect(ctx, chatX + 24, y, 500, 42, 10, s[0] === "done" ? "#10241c" : "#1a1e2a");
    ctx.font = "400 22px Inter, sans-serif"; ctx.fillStyle = s[0] === "done" ? "#34d399" : TEXT;
    ctx.fillText((s[0] === "done" ? "✓ " : "") + s[1], chatX + 44, y + 22);
  }
  ctx.globalAlpha = 1;
});

// ---- right: preview area with resolving takes ----
const pvX = 700, pvY = 40, pvW = W - 740, pvH = H - 300;
drawRoundedRect(ctx, pvX, pvY, pvW, pvH, 16, "#0e1118", BORDER);
[0, 1].forEach((i) => {
  const t0 = 60 + i * 50;
  if (frame < t0) return;
  const a = interpolate(frame, [t0, t0 + 24], [0, 1]);
  const bx = pvX + 40 + i * (pvW / 2), by = pvY + 60, bw = pvW / 2 - 80, bh = pvH - 160;
  ctx.globalAlpha = a;
  drawGradient(ctx, bx, by, bw, bh, i === 0 ? ["#101c2c", "#1c1030"] : ["#0c2030", "#2a0f28"], "diagonal");
  const shim = ((frame - t0) * 14) % (bw + 200) - 100;
  ctx.globalAlpha = a * 0.25;
  drawGradient(ctx, bx + shim, by, 90, bh, ["rgba(255,255,255,0)", "rgba(255,255,255,0.7)", "rgba(255,255,255,0)"], "horizontal");
  ctx.globalAlpha = a;
  ctx.font = "500 20px Inter, sans-serif"; ctx.fillStyle = DIM; ctx.textAlign = "center";
  ctx.fillText(i === 0 ? "take: hero orbit" : "take: water impact", bx + bw / 2, by + bh + 30);
  ctx.textAlign = "left"; ctx.globalAlpha = 1;
});

// ---- bottom: timeline self-populating ----
const tlY = H - 220, tlH = 160;
drawRoundedRect(ctx, 40, tlY, W - 80, tlH, 16, PANEL, BORDER);
const CLIPS = [
  [60, 0, 260, "#6366f1"], [330, 0, 300, "#22d3ee"], [640, 0, 260, "#e879f9"],
  [910, 0, 340, "#6366f1"], [1260, 0, 240, "#34d399"], [1510, 0, 300, "#fbbf24"],
  [60, 1, 700, "#475069"], [780, 1, 1030, "#475069"]
];
CLIPS.forEach((c, i) => {
  const t0 = 20 + i * 17;
  if (frame < t0) return;
  const s = spring(frame - t0, { stiffness: 160, damping: 14 });
  const rowY = tlY + 24 + c[1] * 66;
  ctx.save();
  ctx.translate(40 + c[0] + c[2] / 2, rowY + 24); ctx.scale(Math.min(1, s), 1);
  drawRoundedRect(ctx, -c[2] / 2, -24, c[2], 48, 8, c[3] + "cc", c[3]);
  ctx.restore();
});
// playhead sweeps as clips land
const phX = 40 + interpolate(frame, [0, 180], [0, W - 80]);
ctx.strokeStyle = "#f8fafc"; ctx.lineWidth = 2;
ctx.beginPath(); ctx.moveTo(phX, tlY - 6); ctx.lineTo(phX, tlY + tlH + 6); ctx.stroke();`;
