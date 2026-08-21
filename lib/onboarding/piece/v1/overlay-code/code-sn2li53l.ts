// GENERATED FILE — do not edit by hand.
// Written by scripts/extract-onboarding-piece.ts (npm run onboarding:extract)
// The draw body of overlay code-sn2li53l, hydrated out of the piece's
// per-overlay code file (composition.json never holds overlay code).
//
// Byte-for-byte the body stored in the piece EXCEPT for the
// 2 font string(s) listed below — whether set via `ctx.font` or passed
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
//   "58px sans-serif" -> "58px Inter, sans-serif"
//   "500 19px Menlo, monospace" -> "500 19px \"JetBrains Mono\", monospace"
export const CODE_SN2LI53L_DRAW = `const { ctx, width: W, height: H, frame } = context;
const BG = "#0b0d12", PANEL = "#12151c", BORDER = "#232838", DIM = "#8b93a7";
ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);

// ---- preview canvas: hand cursor selects the box, then drags it ----
const pvX = 260, pvY = 50, pvW = 1400, pvH = 560;
drawRoundedRect(ctx, pvX - 12, pvY - 12, pvW + 24, pvH + 24, 18, PANEL, BORDER);
drawGradient(ctx, pvX, pvY, pvW, pvH, ["#0d1626", "#1b1028"], "diagonal");

const grabF = 14, endF = 60;
const dragT = interpolate(frame, [grabF, endF], [0, 1], { easing: easeInOut });
const ovX = pvX + 180 + dragT * 620, ovY = pvY + 350 - dragT * 180;
const grabbed = frame >= grabF;

// the overlay box
drawRoundedRect(ctx, ovX, ovY, 360, 110, 12, grabbed ? "rgba(99,102,241,0.25)" : "rgba(99,102,241,0.12)", grabbed ? "#818cf8" : "#4c5578");
ctx.font = "700 40px Inter, sans-serif"; ctx.fillStyle = "#e8eaf0"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
ctx.fillText("ZEPHYRON ONE", ovX + 180, ovY + 55);
// selection handles appear once grabbed
if (grabbed) {
  ctx.fillStyle = "#818cf8";
  [[0, 0], [360, 0], [0, 110], [360, 110]].forEach(([dx, dy]) => ctx.fillRect(ovX + dx - 6, ovY + dy - 6, 12, 12));
}
// click ring at the grab moment
if (frame >= grabF && frame < grabF + 10) {
  const r = interpolate(frame, [grabF, grabF + 10], [12, 60]);
  ctx.globalAlpha = interpolate(frame, [grabF, grabF + 10], [0.8, 0]);
  ctx.strokeStyle = "#c7d2fe"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(ovX + 180, ovY + 60, r, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = 1;
}

// hand cursor: points and glides in, becomes a fist while dragging, releases at the end
const grabX = ovX + 180, grabY = ovY + 62;
const inX = interpolate(frame, [0, grabF], [pvX + pvW - 140, grabX], { easing: easeOutCubic });
const inY = interpolate(frame, [0, grabF], [pvY + pvH - 60, grabY], { easing: easeOutCubic });
const handX = frame < grabF ? inX : grabX;
const handY = frame < grabF ? inY : grabY;
const glyph = frame < grabF ? "👆" : (frame < endF ? "✊" : "👆");
ctx.save();
ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 14; ctx.shadowOffsetY = 4;
ctx.font = "58px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
ctx.fillText(glyph, handX, handY + (frame < grabF ? 28 : 16));
ctx.restore();

// ---- timeline with scrubbing playhead + audio duck dips ----
const tlY = H - 380, tlH = 300;
drawRoundedRect(ctx, 40, tlY, W - 80, tlH, 16, PANEL, BORDER);
[[70, 380, "#6366f1"], [460, 420, "#22d3ee"], [890, 380, "#e879f9"], [1280, 480, "#6366f1"]].forEach((c) => {
  drawRoundedRect(ctx, c[0] + 40 - 40, tlY + 30, c[1], 60, 8, c[2] + "cc", c[2]);
});
const wavY = tlY + 150;
drawRoundedRect(ctx, 60, wavY, W - 140, 70, 8, "#101827", "#1f2a44");
ctx.strokeStyle = "#38bdf8"; ctx.lineWidth = 2;
ctx.beginPath();
for (let x = 0; x < W - 180; x += 4) {
  const g = x / (W - 180);
  const duck = Math.exp(-Math.pow((g - 0.3) * 14, 2)) + Math.exp(-Math.pow((g - 0.65) * 14, 2));
  const amp = (14 + 12 * Math.sin(x / 9) * Math.sin(x / 23)) * (1 - 0.7 * duck);
  ctx.moveTo(80 + x, wavY + 35 - amp);
  ctx.lineTo(80 + x, wavY + 35 + amp);
}
ctx.stroke();
drawRoundedRect(ctx, 80 + (W - 180) * 0.3 - 70, wavY - 44, 140, 34, 8, "#0e1118", BORDER);
ctx.font = '500 19px "JetBrains Mono", monospace'; ctx.fillStyle = "#38bdf8"; ctx.textAlign = "center";
ctx.fillText("duck −12 dB", 80 + (W - 180) * 0.3, wavY - 27);
const scrub = interpolate(Math.sin(frame / 16 - 1.2), [-1, 1], [0.15, 0.8]);
const phX2 = 40 + (W - 80) * scrub;
ctx.strokeStyle = "#f8fafc"; ctx.lineWidth = 2;
ctx.beginPath(); ctx.moveTo(phX2, tlY - 8); ctx.lineTo(phX2, tlY + tlH + 8); ctx.stroke();
ctx.fillStyle = "#f8fafc";
ctx.beginPath(); ctx.moveTo(phX2 - 9, tlY - 8); ctx.lineTo(phX2 + 9, tlY - 8); ctx.lineTo(phX2, tlY + 6); ctx.closePath(); ctx.fill();
ctx.textAlign = "left";`;
