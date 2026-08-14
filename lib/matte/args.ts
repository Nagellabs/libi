import path from "node:path";

/**
 * Pure ffmpeg-args builder for the `matte_compose` op — merges the source
 * RGB (trimmed to the matte range) with the sidecar's per-frame alpha PNG
 * sequence into ONE VP9-alpha WebM cutout.
 *
 * Invariants baked in here (the runner and the sidecar both uphold them):
 *  - The alpha PNGs were written at SOURCE resolution (matte.py resizes the
 *    inference-scale alpha back up), so `alphamerge` needs no scale2ref.
 *  - The alpha sequence contains one PNG per SOURCE frame in range (no fps
 *    decimation) — `[0:v]fps=<framerate>` + `-frames:v <frameCount>` keep the
 *    two inputs frame-aligned and clamp any trailing off-by-one.
 *  - `-auto-alt-ref 0` is REQUIRED: libvpx silently drops the alpha plane
 *    when alt-ref frames are enabled.
 *  - `-an`: a cutout is a visual element; audio stays with the source asset.
 *  - The SOURCE file is the original (storage localPath), never a proxy.
 */
export interface MatteComposeOptions {
  range: { start: number; end: number };
  /** Source fps as reported by the matte sidecar result (`framerate`). */
  framerate: number;
  /** Alpha PNG count from the sidecar result (`frameCount`) — output clamp. */
  frameCount: number;
}

export function buildMatteComposeArgs(
  sourcePath: string,
  alphaDir: string,
  outputPath: string,
  opts: MatteComposeOptions,
): string[] {
  return [
    "-y",
    "-ss", String(opts.range.start),
    "-to", String(opts.range.end),
    "-i", sourcePath,
    "-framerate", String(opts.framerate),
    "-start_number", "0",
    "-i", path.join(alphaDir, "f%06d.png"),
    "-filter_complex",
    `[0:v]fps=${opts.framerate},format=rgba[rgb];[1:v]format=gray[a];[rgb][a]alphamerge[out]`,
    "-map", "[out]",
    "-frames:v", String(opts.frameCount),
    "-c:v", "libvpx-vp9",
    "-pix_fmt", "yuva420p",
    "-auto-alt-ref", "0",
    "-b:v", "0",
    "-crf", "30",
    "-row-mt", "1",
    "-an",
    outputPath,
  ];
}

/** `<base>.<ext>` → `<base>-cutout.webm` (mirrors the `-proxy.mp4` naming). */
export function cutoutFilename(sourceFilename: string): string {
  const ext = path.extname(sourceFilename);
  const base = path.basename(sourceFilename, ext);
  return `${base}-cutout.webm`;
}
