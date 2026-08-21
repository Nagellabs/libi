// GENERATED FILE — do not edit by hand.
// Written by scripts/extract-onboarding-piece.ts (npm run onboarding:extract)
// The draw body of overlay code-t8jwcdp3, hydrated out of the piece's
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
//   "400 32px Menlo, monospace" -> "400 32px \"JetBrains Mono\", monospace"
export const CODE_T8JWCDP3_DRAW = `const { ctx, width: W, height: H, frame } = context;
// palette
const BG = "#0b0d12", PANEL = "#12151c", BORDER = "#232838", TEXT = "#e8eaf0", DIM = "#8b93a7", ACCENT = "#6366f1";
ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);

// chat window
const winW = 1240, winH = 560, wx = (W - winW) / 2, wy = (H - winH) / 2 - 20;
// Enter pop: slight scale punch after send
const sendF = 104;
const punch = frame >= sendF ? 1 + 0.012 * Math.exp(-(frame - sendF) / 5) : 1;
ctx.save();
ctx.translate(W / 2, wy + winH / 2); ctx.scale(punch, punch); ctx.translate(-W / 2, -(wy + winH / 2));
ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 60; ctx.shadowOffsetY = 16;
drawRoundedRect(ctx, wx, wy, winW, winH, 20, PANEL, BORDER);
ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
// titlebar
drawRoundedRect(ctx, wx, wy, winW, 62, 20, "#161a24");
ctx.fillStyle = "#161a24"; ctx.fillRect(wx, wy + 42, winW, 20);
["#f87171", "#fbbf24", "#34d399"].forEach((c, i) => drawCircle(ctx, wx + 34 + i * 32, wy + 31, 8, c));
ctx.font = "600 24px Inter, sans-serif"; ctx.fillStyle = DIM; ctx.textAlign = "center"; ctx.textBaseline = "middle";
ctx.fillText("libi — new piece", wx + winW / 2, wy + 32);

// typed prompt
const PROMPT = "A 36-second launch film for a fictional sneaker. Dark studio, neon rim light, slow-mo water splash. Build it.";
const typeStart = 8, typeEnd = 96;
const nChars = Math.floor(interpolate(frame, [typeStart, typeEnd], [0, PROMPT.length]));
const typed = PROMPT.slice(0, nChars);
ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
drawTextBlock(ctx, typed + (frame < sendF && Math.floor(frame / 8) % 2 === 0 ? "▌" : ""), wx + 48, wy + 130, winW - 96, 46, { font: '400 32px "JetBrains Mono", monospace', color: TEXT });

// input bar + send button
const barY = wy + winH - 96;
drawRoundedRect(ctx, wx + 32, barY, winW - 64, 64, 14, "#0e1118", BORDER);
ctx.font = "400 24px Inter, sans-serif"; ctx.fillStyle = "#5d6474"; ctx.textBaseline = "middle";
ctx.fillText(frame < sendF ? "press ⏎ to send" : "sent", wx + 56, barY + 32);
const btnGlow = frame >= sendF ? Math.exp(-(frame - sendF) / 8) : 0;
drawRoundedRect(ctx, wx + winW - 150, barY + 8, 102, 48, 10, frame >= sendF ? "#818cf8" : ACCENT);
if (btnGlow > 0.02) { ctx.globalAlpha = btnGlow * 0.5; drawCircle(ctx, wx + winW - 99, barY + 32, 70, "#818cf8"); ctx.globalAlpha = 1; }
ctx.fillStyle = "#fff"; ctx.font = "700 22px Inter, sans-serif"; ctx.textAlign = "center";
ctx.fillText("Send ⏎", wx + winW - 99, barY + 33);
ctx.restore();`;
