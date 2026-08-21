/**
 * Render a fixed set of timestamps from a piece and diff them against a saved
 * baseline — the "did my refactor change any pixels?" harness.
 *
 * WHY IT GOES OVER HTTP. `renderCompositionFrames` (lib/render/frame-capture.ts)
 * looks callable in-process, but it delegates to the `export_render` JobManager
 * runner, which drives a hidden window that POSTs its result back to
 * `/api/export/render-result`. There is no in-process path, so this script hits
 * the running server's `/api/render/frames` instead. **libi must be running.**
 *
 * TWO SHARP EDGES IN THAT ROUTE, both handled here:
 *  - `atTimes` is silently truncated to 8 (`route.ts` — `body.atTimes?.slice(0, 8)`),
 *    not rejected. More than 8 timestamps must be sent as separate requests or
 *    the extras vanish without a word.
 *  - the PNGs land in `<storage>/<pieceId>/_verify/`, and every call DELETES the
 *    existing `frame-*.png` there before rendering. So each batch's frames must
 *    be copied out before the next request goes out.
 *
 * Comparison is a direct pixel diff rather than ffmpeg SSIM: both renders are
 * deterministic (canvas draws plus a seek to a fixed timestamp in the same
 * file), so the honest expectation is zero changed pixels, and a structural
 * similarity score would blur exactly the small local differences worth
 * catching — a reticle a few pixels off, a font that fell back.
 *
 * Usage:
 *   npx tsx scripts/compare-frames.ts --piece <id> --times 1,5,12 --save-baseline /tmp/base
 *   npx tsx scripts/compare-frames.ts --piece <id> --times 1,5,12 --compare /tmp/base
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadImage, createCanvas } from "@napi-rs/canvas";

/** The route's own cap. Exported so a test can pin that we batch to it. */
export const MAX_TIMES_PER_REQUEST = 8;

export function batchTimes(times: number[], size = MAX_TIMES_PER_REQUEST): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < times.length; i += size) out.push(times.slice(i, i + size));
  return out;
}

/** Stable per-timestamp filename, so baseline and candidate pair up by name. */
export function frameFilename(time: number): string {
  return `frame-${Math.round(time * 1000)}ms.png`;
}

export interface FrameDiff {
  time: number;
  /** Pixels where any channel differs by more than `channelTolerance`. */
  diffPixels: number;
  totalPixels: number;
  maxChannelDelta: number;
}

/** Compare two PNGs pixel for pixel. Throws when the dimensions disagree —
 *  that is a composition-size change, not a rendering difference. */
export async function diffPng(
  aPath: string,
  bPath: string,
  channelTolerance = 2,
): Promise<Omit<FrameDiff, "time">> {
  const [a, b] = await Promise.all([
    loadImage(await fs.readFile(aPath)),
    loadImage(await fs.readFile(bPath)),
  ]);
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `dimension mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height} (${path.basename(aPath)})`,
    );
  }
  const read = (img: Awaited<ReturnType<typeof loadImage>>) => {
    const c = createCanvas(img.width, img.height);
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    return cx.getImageData(0, 0, img.width, img.height).data;
  };
  const da = read(a);
  const db = read(b);

  let diffPixels = 0;
  let maxChannelDelta = 0;
  for (let i = 0; i < da.length; i += 4) {
    let worst = 0;
    for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs(da[i + c] - db[i + c]));
    if (worst > maxChannelDelta) maxChannelDelta = worst;
    if (worst > channelTolerance) diffPixels++;
  }
  return { diffPixels, totalPixels: (da.length / 4) | 0, maxChannelDelta };
}

interface RenderedFrame {
  time: number;
  path: string;
}

async function renderFrames(
  origin: string,
  pieceId: string,
  times: number[],
  destDir: string,
): Promise<RenderedFrame[]> {
  const out: RenderedFrame[] = [];
  for (const batch of batchTimes(times)) {
    const res = await fetch(`${origin}/api/render/frames`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pieceId, atTimes: batch }),
    });
    const body = (await res.json()) as {
      frames?: { time: number; path: string }[];
      unresolvedFonts?: string[];
      error?: string;
    };
    if (!res.ok || body.error) throw new Error(`render failed: ${body.error ?? res.status}`);
    if (body.unresolvedFonts?.length) {
      process.stdout.write(`  ! unresolved fonts: ${body.unresolvedFonts.join(", ")}\n`);
    }
    // Copy out NOW — the next request wipes _verify/.
    for (const f of body.frames ?? []) {
      const dest = path.join(destDir, frameFilename(f.time));
      await fs.copyFile(f.path, dest);
      out.push({ time: f.time, path: dest });
    }
  }
  return out;
}

interface Args {
  pieceId: string;
  times: number[];
  saveBaseline?: string;
  compare?: string;
  origin: string;
  maxDiffPixels: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const times = (get("--times") ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  return {
    pieceId: get("--piece") ?? "",
    times,
    saveBaseline: get("--save-baseline"),
    compare: get("--compare"),
    origin: get("--origin") ?? `http://127.0.0.1:${get("--port") ?? "3456"}`,
    maxDiffPixels: Number(get("--max-diff-pixels") ?? "0"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pieceId || args.times.length === 0) {
    process.stderr.write(
      "usage: --piece <id> --times 1,5,12 (--save-baseline <dir> | --compare <dir>)\n",
    );
    process.exit(1);
  }

  const destDir = args.saveBaseline ?? path.join("/tmp", `compare-frames-${Date.now()}`);
  await fs.mkdir(destDir, { recursive: true });

  process.stdout.write(
    `rendering ${args.times.length} frame(s) from ${args.pieceId} in ` +
      `${batchTimes(args.times).length} batch(es)\n`,
  );
  const frames = await renderFrames(args.origin, args.pieceId, args.times, destDir);

  if (frames.length !== args.times.length) {
    throw new Error(
      `asked for ${args.times.length} frames, got ${frames.length} — ` +
        `the 8-per-request cap or the copy-out is wrong`,
    );
  }
  process.stdout.write(`wrote ${frames.length} frame(s) to ${destDir}\n`);

  if (!args.compare) return;

  let failures = 0;
  for (const f of frames) {
    const basePath = path.join(args.compare, frameFilename(f.time));
    const d = await diffPng(f.path, basePath);
    const pct = ((d.diffPixels / d.totalPixels) * 100).toFixed(4);
    const bad = d.diffPixels > args.maxDiffPixels;
    if (bad) failures++;
    process.stdout.write(
      `  t=${String(f.time).padStart(5)}s  diff ${String(d.diffPixels).padStart(8)} px ` +
        `(${pct}%)  maxΔ ${String(d.maxChannelDelta).padStart(3)}  ${bad ? "CHANGED" : "ok"}\n`,
    );
  }
  if (failures > 0) {
    process.stderr.write(`\n${failures} frame(s) changed beyond tolerance\n`);
    process.exit(1);
  }
  process.stdout.write(`\nall ${frames.length} frame(s) identical\n`);
}

if (process.argv[1]?.endsWith("compare-frames.ts")) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
