// GENERATED FILE — do not edit by hand.
// Written by scripts/extract-onboarding-piece.ts (npm run onboarding:extract)
// The draw body of overlay code-558ob5uw, hydrated out of the piece's
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
//   "600 30px Menlo, monospace" -> "600 30px \"JetBrains Mono\", monospace"
//   "500 22px Menlo, monospace" -> "500 22px \"JetBrains Mono\", monospace"
//
// 2 ON-SCREEN STRING(S) ALSO DIVERGE, for a different reason —
// the piece shows them to the user and they say something untrue about
// libi. Registered in the emitter's TEXT_CORRECTIONS with the reason:
//
//   "method sot" -> "method botsort"  (sot is a different tracker; botsort is what actually associated these boxes)
//   "engine yoloe+botsort" -> "engine yoloe"  (pairs with the method chip above — yoloe detects, botsort tracks)
export const CODE_558OB5UW_DRAW = `const { ctx, width: W, height: H, frame } = context;
const BG = "#0b0d12", PANEL = "#12151c", BORDER = "#232838", DIM = "#8b93a7";
ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
ctx.strokeStyle = "rgba(255,255,255,0.025)"; ctx.lineWidth = 1;
for (let x = 0; x <= W; x += 120) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
for (let y = 0; y <= H; y += 120) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

// header
ctx.textAlign = "center"; ctx.textBaseline = "middle";
ctx.font = "700 40px Inter, sans-serif"; ctx.fillStyle = "#e8eaf0";
ctx.fillText("Object tracking", W / 2, 92);

// ---- centered video demo panel (clip + HUD overlays land exactly in the well) ----
const px = 320, py = 150, pw = 1280, ph = 720;
ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 40; ctx.shadowOffsetY = 10;
drawRoundedRect(ctx, px - 14, py - 14, pw + 28, ph + 28, 18, PANEL, BORDER);
ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
ctx.fillStyle = "#05070a"; ctx.fillRect(px, py, pw, ph);

// completion card — footage ends at local f180 (0:22); holds through 0:24
if (frame > 180) {
  const a = interpolate(frame, [180, 190], [0, 1]);
  const pop = 0.94 + 0.06 * Math.min(1, spring(frame - 180, { stiffness: 170, damping: 15 }));
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(px + pw / 2, py + ph / 2); ctx.scale(pop, pop); ctx.translate(-(px + pw / 2), -(py + ph / 2));
  const msg = "track complete ✓  145/145 frames";
  ctx.font = '600 30px "JetBrains Mono", monospace';
  const bw = ctx.measureText(msg).width + 88;
  drawRoundedRect(ctx, px + pw / 2 - bw / 2, py + ph / 2 - 52, bw, 104, 14, "#10241c", "#1e4a38");
  ctx.fillStyle = "#8ef0c0"; ctx.textAlign = "center";
  ctx.fillText(msg, px + pw / 2, py + ph / 2 + 2);
  ctx.restore();
  ctx.globalAlpha = 1;
}

// ---- telemetry strip below the panel ----
const locked = frame >= 45 && frame <= 180;
const conf = frame < 45 ? "—" : (0.94 + 0.04 * (0.5 + 0.5 * Math.sin(frame / 17))).toFixed(2);
const nfr = frame < 45 ? 0 : Math.min(145, Math.round((frame - 45) * 1.05));
const status = frame < 45 ? "searching" : frame > 180 ? "done" : "locked";
const ITEMS = ["engine yoloe", "method botsort", \`conf \${conf}\`, \`frames \${nfr}/145\`, status];
ctx.font = '500 22px "JetBrains Mono", monospace';
const widths = ITEMS.map((s) => ctx.measureText(s).width + 44);
const total = widths.reduce((a, b) => a + b, 0) + (ITEMS.length - 1) * 18;
let bx = (W - total) / 2;
const byy = py + ph + 44;
ITEMS.forEach((s, i) => {
  const isStatus = i === ITEMS.length - 1;
  drawRoundedRect(ctx, bx, byy, widths[i], 46, 10, isStatus ? (frame < 45 ? "#2a230e" : "#10241c") : "#0e1118", BORDER);
  ctx.fillStyle = isStatus ? (frame < 45 ? "#fbbf24" : "#34d399") : "#9aa3b2";
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText(s, bx + 22, byy + 24);
  bx += widths[i] + 18;
});
ctx.textAlign = "left";`;
