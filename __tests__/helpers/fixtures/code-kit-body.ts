/**
 * A ~200-line "style kit" body shaped like the ones the Dreams session read
 * whole: a palette, size constants, a handful of drawing helpers, and the
 * scene code at the bottom. Generated, so the test can ask the file where
 * things are instead of hard-coding line numbers.
 */
const HELPERS = ["heart", "star", "blob", "sparkle", "ribbon", "confetti", "doily", "tape"] as const;

function helperBlock(name: string): string {
  return [
    `function ${name}(ctx, cx, cy, size = 40, fill = PAPER) {`,
    `  ctx.save();`,
    `  ctx.translate(cx, cy);`,
    `  ctx.fillStyle = fill;`,
    `  ctx.beginPath();`,
    `  for (let i = 0; i < 8; i++) {`,
    `    const a = (i / 8) * Math.PI * 2;`,
    `    const r = size * (0.6 + 0.4 * Math.sin(a * 3));`,
    `    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);`,
    `  }`,
    `  ctx.closePath();`,
    `  ctx.fill();`,
    `  ctx.lineWidth = 2;`,
    `  ctx.strokeStyle = INK;`,
    `  ctx.stroke();`,
    `  // speckle: a few grains of ink inside the shape, from the kit's own seeded rand()`,
    `  ctx.fillStyle = INK;`,
    `  for (let i = 0; i < 6; i++) {`,
    `    const gx = (rand() - 0.5) * size;`,
    `    const gy = (rand() - 0.5) * size;`,
    `    ctx.globalAlpha = GRAIN;`,
    `    ctx.fillRect(gx, gy, 2, 2);`,
    `  }`,
    `  ctx.globalAlpha = 1;`,
    `  ctx.restore();`,
    `}`,
    ``,
  ].join("\n");
}

export const KIT_BODY: string = [
  `// ── riso kit ─────────────────────────────────────────────`,
  `const { ctx, width, height, frame, fps, time } = context;`,
  `const INK = "#1b1b3a";`,
  `const PAPER = "#f4e8d0";`,
  `const PALETTE = ["#ff5d8f", "#ffb703", "#3a86ff", "#06d6a0"];`,
  `const SIZES = { title: 96, body: 40, caption: 28 };`,
  `const MARGIN = 64;`,
  `const GRAIN = 0.35;`,
  `let seed = 7;`,
  `const TITLE_FONT = "700 96px Fraunces, serif";`,
  `const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };`,
  `const lerp = (a, b, t) => a + (b - a) * t;`,
  ``,
  ...HELPERS.flatMap((h) => helperBlock(h).split("\n")),
  `async function withLabel(ctx, text, x, y) {`,
  `  ctx.font = "600 " + SIZES.body + "px Inter, sans-serif";`,
  `  ctx.fillStyle = INK;`,
  `  ctx.fillText(text, x, y);`,
  `}`,
  ``,
  `// ── scene ────────────────────────────────────────────────`,
  `const enter = interpolate(time, [0, 0.6], [0, 1], { easing: easeOutCubic });`,
  `ctx.fillStyle = PAPER;`,
  `ctx.fillRect(0, 0, width, height);`,
  `ctx.globalAlpha = enter;`,
  `ctx.font = TITLE_FONT;`,
  `ctx.fillStyle = INK;`,
  `ctx.fillText("Dreams", MARGIN, height / 2);`,
  `drawRoundedRect(ctx, MARGIN, height / 2 + 24, width - MARGIN * 2, 6, 3, PALETTE[0]);`,
  `heart(ctx, width - 140, 160, 48, PALETTE[0]);`,
  `star(ctx, 120, 200, 36, PALETTE[1]);`,
  ``,
].join("\n");

export const KIT_HELPER_NAMES: readonly string[] = HELPERS;
