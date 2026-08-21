// GENERATED FILE — do not edit by hand.
// Written by scripts/extract-onboarding-piece.ts (npm run onboarding:extract)
// The draw body of overlay code-c5da91a2, hydrated out of the piece's
// per-overlay code file (composition.json never holds overlay code).
//
// THIS WAS A `tracked` OVERLAY IN THE SOURCE PIECE (tracked-c5da91a2), driven by a
// real 145-sample object track. It ships as a plain `code` overlay with the
// track's boxes baked in, because object tracking needs a local model libi
// provisions on first use and the demo must not depend on it — see the
// "Slot D" section of scripts/extract-onboarding-piece.ts for the full
// reasoning. The boxes are what the engine's own placement path resolved,
// so the reticle draws where it always drew.
//
// 136 of 136 frames carry a box; 0 are gaps the subject was not
// visible on. Coordinates are composition pixels rounded to 2 decimals.
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
//   "500 20px Menlo, monospace" -> "500 20px \"JetBrains Mono\", monospace"
export const CODE_C5DA91A2_DRAW = `// Slot D's tracking reticle. The path below was produced by libi's real
// object tracking on this footage and then baked, frame by frame, into the
// composition coordinates it draws at — so this overlay needs no track, no
// tracking model, and no runtime transform.
const RETICLE = context;
const RETICLE_CTX = RETICLE.ctx;

// INK PIN — two all-but-invisible pixels at opposite corners of the rect.
// A plain code overlay is contain-FIT: the renderer probes the union alpha
// bbox of what this body draws and scales it to fill the rect
// (lib/overlays/code-content-fit.ts). Every other code overlay in this film
// happens to paint corner to corner, so the fit is the identity for them.
// This one paints a small box that MOVES, and without the pin the probe
// would measure a fraction of the frame and blow the reticle up ~2.3x.
// Alpha 0.01 is one step above transparent: it registers as ink and cannot
// register as a pixel.
RETICLE_CTX.fillStyle = "rgba(52,211,153,0.01)";
RETICLE_CTX.fillRect(0, 0, 1, 1);
RETICLE_CTX.fillRect(RETICLE.width - 1, RETICLE.height - 1, 1, 1);

// [x, y, w, h] in composition pixels, one row per frame of this overlay.
// null = a frame the subject was not visible on, which drew nothing.
const RETICLE_BOXES = [
  [579.48, 299.76, 838.7, 408.84],
  [579.69, 300.7, 837.89, 408.84],
  [580.33, 300.46, 836.34, 409.33],
  [581.57, 300.1, 835.24, 409.73],
  [583.03, 300.01, 834.77, 409.89],
  [583.79, 299.91, 834.11, 410.05],
  [585.34, 299.83, 833.2, 410.14],
  [587.38, 299.33, 829.82, 411.32],
  [589.4, 298.98, 827.43, 412.09],
  [591.32, 298.94, 826.6, 412.09],
  [593.45, 298.96, 824.95, 412.09],
  [595.74, 298.52, 822, 412.7],
  [598.35, 298.88, 819.45, 412.86],
  [600.88, 298.69, 815.87, 413.49],
  [602.96, 297.83, 812.11, 414.61],
  [604.24, 297.39, 811.24, 415.24],
  [605.56, 296.57, 811.24, 416.44],
  [607.39, 296.38, 811, 416.75],
  [608.59, 296.67, 810.64, 416.14],
  [609.1, 297.12, 810.12, 415.21],
  [609.99, 297.29, 809.22, 415.08],
  [610.75, 297.46, 809.67, 414.8],
  [612.42, 297.55, 809.44, 414.73],
  [614.63, 297.96, 808.4, 414.14],
  [616.83, 298.69, 807.12, 413.24],
  [618.33, 299.37, 806.91, 413.24],
  [619.99, 299.56, 803.26, 412.57],
  [621.74, 299.84, 800.65, 412.49],
  [623.65, 299.92, 797.54, 412.45],
  [625.46, 299.81, 794.5, 412.28],
  [626.55, 299.79, 794.27, 412.28],
  [628.27, 300.14, 793.73, 411.8],
  [630.52, 300.28, 792.88, 411.68],
  [633.01, 300.81, 792, 411.68],
  [635.24, 301.57, 791.35, 411.62],
  [636.45, 301.67, 791.1, 411.39],
  [638.02, 302.72, 790.63, 410.59],
  [638.87, 302.78, 790.15, 410.39],
  [639.92, 302.66, 789.92, 410.39],
  [641.85, 302.94, 789.21, 409.93],
  [645.14, 303.98, 786.34, 408.11],
  [646.87, 304.71, 785.97, 407.49],
  [648.39, 305.89, 785.85, 405.68],
  [649.65, 306.8, 785.83, 404.09],
  [651, 307.34, 785.28, 403.31],
  [653.16, 307.96, 783.07, 403.05],
  [655.29, 308.27, 780.44, 402.55],
  [657.07, 308.41, 778.6, 402.3],
  [658.79, 308.99, 777.33, 401.6],
  [660.73, 309.83, 776.15, 400.69],
  [663.14, 309.92, 774.28, 400.67],
  [664.43, 310.38, 773.8, 400.46],
  [666.58, 310.67, 771.51, 400.29],
  [669.19, 310.88, 768.21, 400.08],
  [671.88, 311.1, 764.88, 399.88],
  [674.3, 311.37, 762.65, 399.86],
  [675.63, 311.58, 761.98, 399.74],
  [677.71, 311.74, 760.03, 399.52],
  [679.76, 311.92, 758.46, 399.35],
  [681.62, 312.16, 757.44, 399.27],
  [683.68, 312.47, 755.67, 399.15],
  [685.38, 312.49, 754.61, 399.11],
  [687.32, 312.94, 753.38, 398.52],
  [689.18, 313.39, 752.02, 398.13],
  [690.75, 313.88, 750.9, 397.72],
  [691.96, 314.94, 750.69, 396.19],
  [694.25, 315.5, 747.95, 395.95],
  [696.15, 316.18, 746.04, 395.19],
  [697.98, 316.78, 744.72, 394.7],
  [699.92, 317.14, 743.51, 394.67],
  [702.08, 317.22, 741.61, 394.67],
  [703.55, 317.71, 740.47, 394.64],
  [706.44, 317.93, 738.2, 394.62],
  [708.87, 318.01, 735.73, 394.61],
  [710.51, 318.16, 733.53, 394.51],
  [712.48, 318.63, 731.54, 394.11],
  [714.08, 318.83, 730.3, 393.86],
  [715.85, 319.37, 729.54, 393.8],
  [718.24, 319.73, 726.78, 393.68],
  [721.17, 319.99, 722.74, 393.46],
  [724.09, 320.8, 721.31, 393.26],
  [726.1, 320.58, 716.4, 393.15],
  [728.41, 320.98, 714.28, 393.03],
  [729.93, 321.28, 713.12, 392.9],
  [731.39, 321.5, 711.56, 392.59],
  [735.3, 322.44, 708.71, 391.76],
  [736.11, 322.52, 707.09, 391.35],
  [738.24, 323.04, 706.41, 391.05],
  [740.55, 323.39, 704.36, 390.87],
  [742.67, 323.66, 701.34, 390.6],
  [745, 324.69, 700.42, 389.85],
  [747.65, 324.85, 695.55, 389.66],
  [750.31, 325.42, 693.2, 389.31],
  [752.48, 325.82, 690.84, 389.01],
  [754.21, 326.12, 688.38, 388.65],
  [756.05, 327.1, 688.1, 387.87],
  [758.2, 327.28, 683.81, 387.53],
  [760.85, 327.85, 681.87, 387.34],
  [763.41, 328.43, 679.6, 386.85],
  [765.88, 328.94, 676.7, 386.19],
  [768.79, 329.64, 675.28, 386.11],
  [771.05, 329.75, 671.16, 386.11],
  [773.15, 330.22, 669.75, 385.95],
  [775.68, 330.65, 667.05, 385.84],
  [778.19, 330.99, 663.3, 385.76],
  [779.29, 331.58, 662.99, 385.47],
  [781.19, 331.64, 658.88, 385.47],
  [782.98, 331.88, 657.47, 385.29],
  [785.32, 332.09, 654.77, 385.17],
  [787.93, 332.22, 651.03, 385.16],
  [789.6, 332.41, 650.72, 385.1],
  [792.5, 332.58, 645.95, 385.1],
  [795.34, 332.81, 643.11, 384.92],
  [798.3, 333.4, 639.44, 384.61],
  [800.84, 334.19, 635.56, 384.16],
  [801.7, 334.57, 635.44, 383.52],
  [805.66, 335.5, 631.06, 382.77],
  [808.75, 336.02, 626.95, 382.03],
  [811.6, 336.34, 624.07, 381.55],
  [814.37, 336.72, 622, 381.18],
  [816.73, 337.46, 618.99, 380.28],
  [819.19, 338.99, 617.18, 377.66],
  [822.31, 339.59, 612.97, 376.81],
  [824.83, 340.18, 609.94, 376.09],
  [826.89, 340.86, 608.18, 375.21],
  [830.03, 340.91, 604.29, 375.21],
  [832.77, 341.26, 601.95, 374.91],
  [835.83, 341.61, 598.84, 374.67],
  [838.73, 341.98, 595.82, 374.32],
  [841.35, 342.28, 593.25, 373.96],
  [843.91, 342.37, 590.99, 373.96],
  [846.22, 342.42, 588.98, 373.96],
  [849.09, 342.74, 587.08, 373.91],
  [852.25, 342.97, 584.62, 374.33],
  [855.68, 343.11, 581.68, 375.02],
  [859.69, 343.58, 579.18, 375.02],
];
const RETICLE_I =
  RETICLE.frame < 0
    ? 0
    : RETICLE.frame >= RETICLE_BOXES.length
      ? RETICLE_BOXES.length - 1
      : RETICLE.frame;
const RETICLE_BOX = RETICLE_BOXES[RETICLE_I];
if (RETICLE_BOX) {
  RETICLE_CTX.save();
  RETICLE_CTX.translate(RETICLE_BOX[0], RETICLE_BOX[1]);
  // The reticle body, verbatim, called exactly as the tracked renderer
  // called it: same ctx (already at the box origin), box-sized width and
  // height, and this overlay's own element-local clock.
  (function (context) {
const { ctx, width: W, height: H, frame } = context;
const PULSE = 0.7 + 0.3 * Math.sin(frame / 6);
const COL = "#34d399";
// marching dashed bounds
ctx.setLineDash([12, 10]);
ctx.lineDashOffset = -frame * 1.6;
ctx.strokeStyle = \`rgba(52,211,153,\${0.35 * PULSE})\`;
ctx.lineWidth = 2;
ctx.strokeRect(3, 3, W - 6, H - 6);
ctx.setLineDash([]);
ctx.lineDashOffset = 0;
// pulsing corner brackets
const t = Math.min(W, H) * 0.14 * (0.92 + 0.08 * PULSE);
ctx.strokeStyle = COL;
ctx.lineWidth = 5;
ctx.lineCap = "round";
[[3, 3, 1, 1], [W - 3, 3, -1, 1], [3, H - 3, 1, -1], [W - 3, H - 3, -1, -1]].forEach(([x, y, dx, dy]) => {
  ctx.beginPath();
  ctx.moveTo(x, y + dy * t);
  ctx.lineTo(x, y);
  ctx.lineTo(x + dx * t, y);
  ctx.stroke();
});
// soft glow sweep along the top edge
const sx = ((frame * 9) % (W + 120)) - 60;
const g = ctx.createLinearGradient(sx - 60, 0, sx + 60, 0);
g.addColorStop(0, "rgba(52,211,153,0)");
g.addColorStop(0.5, \`rgba(52,211,153,\${0.5 * PULSE})\`);
g.addColorStop(1, "rgba(52,211,153,0)");
ctx.fillStyle = g;
ctx.fillRect(0, 0, W, 4);
// label chip inside top-left
ctx.font = '500 20px "JetBrains Mono", monospace';
const label = "track: sneaker";
const lw = ctx.measureText(label).width + 30;
ctx.fillStyle = "rgba(8,20,15,0.85)";
ctx.beginPath();
ctx.roundRect(14, 14, lw, 34, 8);
ctx.fill();
ctx.fillStyle = COL;
ctx.textAlign = "left";
ctx.textBaseline = "middle";
ctx.fillText(label, 28, 32);
  })({ ...RETICLE, width: RETICLE_BOX[2], height: RETICLE_BOX[3] });
  RETICLE_CTX.restore();
}`;
