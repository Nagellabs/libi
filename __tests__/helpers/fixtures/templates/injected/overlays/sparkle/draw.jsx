const { ctx, width, height, frame, totalFrames } = context;
const t = totalFrames > 0 ? frame / totalFrames : 0;
ctx.fillStyle = `rgba(255, 212, 0, ${Math.max(0, 0.6 - t)})`;
ctx.fillRect(0, height * 0.45, width * t, 6);
