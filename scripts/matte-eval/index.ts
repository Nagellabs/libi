/**
 * matte-eval — the standing acceptance harness for background removal.
 *
 * Runs the sidecar's `method:"matte"` (MatAnyone) on a REAL clip, dumps
 * per-frame alpha PNGs, renders a composite-over-solid-color preview MP4,
 * extracts spot-check stills, and prints measured ms/frame.
 *
 *   npm run matte:eval -- --src /abs/path/to/person-clip.mp4 \
 *     [--range 0-6] [--seed x,y,w,h] [--out /tmp/matte-eval] [--max-dim 1080]
 *
 * ACCEPTANCE IS BY EYE (pixels, not counts): open the stills, check hair
 * edges + temporal stability, and read the printed ms/frame.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { runMatteSegment } from "@/lib/tracking/matte-runner";
import { resolveFfmpegPath } from "@/lib/ffmpeg/exec";

const pexec = promisify(execFile);

interface Args {
  src: string;
  range: { start: number; end: number };
  seed: [number, number, number, number] | null;
  out: string;
  maxDim: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const src = get("--src");
  if (!src || !existsSync(src)) {
    throw new Error("--src /abs/path/to/clip.mp4 is required (file must exist)");
  }
  const rangeRaw = get("--range") ?? "0-6";
  const [a, b] = rangeRaw.split("-").map(Number);
  const seedRaw = get("--seed");
  const seed = seedRaw
    ? (seedRaw.split(",").map(Number) as [number, number, number, number])
    : null;
  return {
    src: resolve(src),
    range: { start: a, end: b },
    seed,
    out: resolve(get("--out") ?? "/tmp/matte-eval"),
    maxDim: Number(get("--max-dim") ?? 1080),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const alphaDir = join(args.out, "alpha");
  mkdirSync(alphaDir, { recursive: true });

  console.log(`matte-eval: ${args.src} range ${args.range.start}-${args.range.end}s`);
  const r = await runMatteSegment({
    videoPath: args.src,
    range: args.range,
    outputDir: alphaDir,
    seedBox: args.seed,
    maxDim: args.maxDim,
    onProgress: (done, total) =>
      process.stdout.write(`\r  matting ${done}/${total} frames`),
  });
  process.stdout.write("\n");
  if (r.error || !r.frameCount) {
    console.error(`FAILED: ${r.error ?? "0 frames"} — no matte produced`);
    process.exit(2);
  }
  const fps = r.framerate;
  console.log(
    `frames: ${r.frameCount}  device: ${r.device}  MEASURED: ${r.msPerFrame} ms/frame` +
      `  coverage: ${(r.coverage * 100).toFixed(2)}%` +
      (r.flags.length ? `  FLAGS: ${r.flags.join(",")}` : ""),
  );

  // Composite-over-solid-color preview (green = alpha errors pop visually).
  const preview = join(args.out, "preview.mp4");
  await pexec(resolveFfmpegPath(), [
    "-y",
    "-ss", String(args.range.start),
    "-to", String(args.range.end),
    "-i", args.src,
    "-framerate", String(fps),
    "-start_number", "0",
    "-i", join(alphaDir, "f%06d.png"),
    "-filter_complex",
    `[0:v]fps=${fps},format=rgba[rgb];[1:v]format=gray[a];` +
      `[rgb][a]alphamerge[cut];color=c=0x00c853[bgsrc];` +
      `[bgsrc][cut]scale2ref[bg][cut2];[bg][cut2]overlay=shortest=1[out]`,
    "-map", "[out]",
    "-frames:v", String(r.frameCount),
    "-pix_fmt", "yuv420p",
    preview,
  ], { maxBuffer: 32 * 1024 * 1024 });

  // Spot-check stills — evenly spaced across the range, plus the ends.
  const dur = args.range.end - args.range.start;
  const stamps = [0.1, dur * 0.25, dur * 0.5, dur * 0.75, Math.max(0.1, dur - 0.2)];
  for (const s of stamps) {
    const still = join(args.out, `still-${s.toFixed(1)}s.png`);
    await pexec(resolveFfmpegPath(), [
      "-y", "-ss", String(s), "-i", preview, "-frames:v", "1", still,
    ]);
  }

  const pngs = readdirSync(alphaDir).filter((f) => f.endsWith(".png")).length;
  console.log(`alpha PNGs: ${pngs} → ${alphaDir}`);
  console.log(`preview:    ${preview}`);
  console.log(`stills:     ${args.out}/still-*.png`);
  console.log("\nACCEPTANCE (by eye): open the stills — subject clean? hair edges");
  console.log("sharp? no gross flicker between consecutive stills? Record ms/frame.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
