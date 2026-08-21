// GENERATED FILE — do not edit by hand.
// Written by scripts/extract-onboarding-piece.ts (npm run onboarding:extract)
// The draw body of overlay code-t9hx2cb7, hydrated out of the piece's
// per-overlay code file (composition.json never holds overlay code).
//
// Byte-for-byte the body stored in the piece. Only a backtick and a
// `${` are escaped — nothing else is reformatted, because this string is
// compiled and run, not read.
export const CODE_T9HX2CB7_DRAW = `const { ctx, width, height, frame } = context;
// fade the card in over the film's last frames
const a = Math.min(1, frame / 10);
ctx.globalAlpha = a;
ctx.fillStyle = "#08090c";
ctx.fillRect(0, 0, width, height);
const g = ctx.createRadialGradient(width / 2, height / 2, height * 0.2, width / 2, height / 2, height * 0.9);
g.addColorStop(0, "rgba(18,20,28,0.5)");
g.addColorStop(1, "rgba(0,0,0,0.95)");
ctx.fillStyle = g;
ctx.fillRect(0, 0, width, height);
ctx.globalAlpha = 1;`;
