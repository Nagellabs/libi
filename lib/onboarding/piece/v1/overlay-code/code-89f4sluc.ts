// GENERATED FILE — do not edit by hand.
// Written by scripts/extract-onboarding-piece.ts (npm run onboarding:extract)
// The draw body of overlay code-89f4sluc, hydrated out of the piece's
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
//   "500 20px Menlo, monospace" -> "500 20px \"JetBrains Mono\", monospace"
//   "500 22px Menlo, monospace" -> "500 22px \"JetBrains Mono\", monospace"
export const CODE_89F4SLUC_DRAW = `const { ctx, width: W, height: H, frame } = context;
const G = "rgba(52,211,153,"; // sci-fi green
// roaming reticle — deliberately NOT locked to anything, darting around searching
const rx = W / 2 + Math.sin(frame / 9) * W * 0.3 + Math.sin(frame / 4.3) * 60;
const ry = H / 2 + Math.cos(frame / 7.1) * H * 0.26 + Math.sin(frame / 3.7) * 40;

// full-frame crosshair lines following the reticle
ctx.strokeStyle = G + "0.18)";
ctx.lineWidth = 1;
ctx.beginPath(); ctx.moveTo(rx, 0); ctx.lineTo(rx, H); ctx.moveTo(0, ry); ctx.lineTo(W, ry); ctx.stroke();

// horizontal scan band sweeping down the frame
const bandY = ((frame * 14) % (H + 240)) - 120;
const bg = ctx.createLinearGradient(0, bandY - 90, 0, bandY + 90);
bg.addColorStop(0, G + "0)"); bg.addColorStop(0.5, G + "0.07)"); bg.addColorStop(1, G + "0)");
ctx.fillStyle = bg; ctx.fillRect(0, bandY - 90, W, 180);

// reticle — rotating gapped rings + center dot
ctx.save();
ctx.translate(rx, ry);
ctx.strokeStyle = G + "0.95)"; ctx.lineWidth = 3; ctx.lineCap = "round";
const a = frame * 0.12;
[64, 90].forEach((r, i) => {
  const dir = i === 0 ? 1 : -1;
  for (let k = 0; k < 3; k++) {
    ctx.beginPath();
    ctx.arc(0, 0, r, a * dir + k * (Math.PI * 2 / 3), a * dir + k * (Math.PI * 2 / 3) + Math.PI / 3);
    ctx.stroke();
  }
});
ctx.fillStyle = G + "0.9)";
ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2); ctx.fill();
// inner cross ticks
ctx.beginPath();
[[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dx, dy]) => {
  ctx.moveTo(dx * 40, dy * 40); ctx.lineTo(dx * 22, dy * 22);
});
ctx.stroke();
ctx.restore();

// candidate blips flashing at deterministic spots — rejected targets
[[0.22, 0.3], [0.72, 0.22], [0.3, 0.74], [0.8, 0.66], [0.55, 0.42]].forEach(([px, py], i) => {
  const phase = (frame + i * 13) % 42;
  if (phase > 10) return;
  const al = phase < 5 ? phase / 5 : 1 - (phase - 5) / 5;
  ctx.strokeStyle = G + (0.6 * al) + ")";
  ctx.lineWidth = 2;
  ctx.strokeRect(W * px - 26, H * py - 26, 52, 52);
  ctx.font = '500 20px "JetBrains Mono", monospace';
  ctx.fillStyle = G + (0.7 * al) + ")";
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("?", W * px + 34, H * py);
});

// corner frame ticks
ctx.strokeStyle = G + "0.5)"; ctx.lineWidth = 3;
const T = 46, M = 28;
[[M, M, 1, 1], [W - M, M, -1, 1], [M, H - M, 1, -1], [W - M, H - M, -1, -1]].forEach(([x, y, dx, dy]) => {
  ctx.beginPath(); ctx.moveTo(x, y + dy * T); ctx.lineTo(x, y); ctx.lineTo(x + dx * T, y); ctx.stroke();
});

// status chip
const dots = ".".repeat(1 + (Math.floor(frame / 9) % 3));
const last = frame > 20;
const label = last ? "signal detected" : "scanning" + dots;
ctx.font = '500 22px "JetBrains Mono", monospace';
const lw = ctx.measureText(last ? label : "scanning...").width + 34;
ctx.fillStyle = "rgba(8,20,15,0.85)";
ctx.beginPath(); ctx.roundRect(40, H - 96, lw, 40, 8); ctx.fill();
ctx.fillStyle = last ? "#8ef0c0" : G + "0.9)";
ctx.textAlign = "left"; ctx.textBaseline = "middle";
ctx.fillText(label, 57, H - 76);`;
