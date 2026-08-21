// GENERATED FILE — do not edit by hand.
// Written by scripts/extract-onboarding-piece.ts (npm run onboarding:extract)
// The draw body of overlay code-n4yq9kv5, hydrated out of the piece's
// per-overlay code file (composition.json never holds overlay code).
//
// Byte-for-byte the body stored in the piece. Only a backtick and a
// `${` are escaped — nothing else is reformatted, because this string is
// compiled and run, not read.
export const CODE_N4YQ9KV5_DRAW = `const { ctx, width: W, height: H, frame } = context;
// pro-ad dimming: footage darkens toward the edges as the brand lockup lands
const a = Math.min(1, frame / 12);
const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.12, W / 2, H / 2, H * 0.95);
g.addColorStop(0, \`rgba(0,0,0,\${0.45 * a})\`);
g.addColorStop(1, \`rgba(0,0,0,\${0.85 * a})\`);
ctx.fillStyle = g;
ctx.fillRect(0, 0, W, H);`;
