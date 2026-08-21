// GENERATED FILE — do not edit by hand.
// Written by scripts/extract-onboarding-piece.ts (npm run onboarding:extract)
// The draw body of overlay code-mryim9r3, hydrated out of the piece's
// per-overlay code file (composition.json never holds overlay code).
//
// Byte-for-byte the body stored in the piece. Only a backtick and a
// `${` are escaped — nothing else is reformatted, because this string is
// compiled and run, not read.
export const CODE_MRYIM9R3_DRAW = `const { ctx, width: W, height: H, frame } = context;
const BG = "#0b0d12", PANEL = "#12151c", BORDER = "#232838", DIM = "#8b93a7";
ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);

// export modal
const mw = 760, mh = 380, mx = (W - mw) / 2, my = (H - mh) / 2;
ctx.shadowColor = "rgba(0,0,0,0.55)"; ctx.shadowBlur = 70; ctx.shadowOffsetY = 18;
drawRoundedRect(ctx, mx, my, mw, mh, 20, PANEL, BORDER);
ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
ctx.font = "700 40px Inter, sans-serif"; ctx.fillStyle = "#e8eaf0"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
ctx.fillText("Export", mx + 44, my + 62);
ctx.font = "400 24px Inter, sans-serif"; ctx.fillStyle = DIM;
ctx.fillText("1920 × 1080 · 30 fps · MP4", mx + 44, my + 106);

const clickF = 15;
const clicked = frame >= clickF;
if (!clicked) {
  drawRoundedRect(ctx, mx + 44, my + 170, mw - 88, 84, 14, "#6366f1");
  ctx.font = "700 30px Inter, sans-serif"; ctx.fillStyle = "#fff"; ctx.textAlign = "center";
  ctx.fillText("Export video", mx + mw / 2, my + 213);
} else {
  const prog = interpolate(frame, [clickF + 3, 80], [0, 1]);
  drawRoundedRect(ctx, mx + 44, my + 170, mw - 88, 84, 14, "#0e1118", BORDER);
  const done = prog >= 1;
  drawRoundedRect(ctx, mx + 48, my + 174, (mw - 96) * Math.min(1, prog), 76, 12, done ? "#34d399" : "#818cf8");
  ctx.font = "700 28px Inter, sans-serif"; ctx.fillStyle = done ? "#052e1e" : "#fff"; ctx.textAlign = "center";
  ctx.fillText(done ? "✓ exported" : \`\${Math.round(prog * 100)}%\`, mx + mw / 2, my + 213);
}
if (frame >= clickF && frame < clickF + 10) {
  const r = interpolate(frame, [clickF, clickF + 10], [10, 60]);
  ctx.globalAlpha = interpolate(frame, [clickF, clickF + 10], [0.8, 0]);
  ctx.strokeStyle = "#f8fafc"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(mx + mw / 2 + 120, my + 226, r, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = 1;
}
const cx2 = interpolate(frame, [0, clickF], [mx + mw / 2 + 320, mx + mw / 2 + 118], { easing: easeOutCubic });
const cy2 = interpolate(frame, [0, clickF], [my + 340, my + 222], { easing: easeOutCubic });
ctx.fillStyle = "#f8fafc";
ctx.beginPath();
ctx.moveTo(cx2, cy2);
ctx.lineTo(cx2 + 6, cy2 + 30);
ctx.lineTo(cx2 + 13, cy2 + 20);
ctx.lineTo(cx2 + 26, cy2 + 24);
ctx.closePath();
ctx.fill();
ctx.textAlign = "left";`;
