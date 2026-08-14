export interface BuildFilmstripOptions {
  /** Number of frames tiled horizontally into the sprite. */
  frames: number;
  /** Per-frame height in px (sprite height; width auto from aspect). */
  height: number;
  /**
   * The pre-computed ffmpeg `fps` filter value, as a string. The runner
   * probes the clip duration first and passes `frames / duration` (e.g.
   * `"20/13.4"` or `"1.49"`) so we sample exactly `frames` frames evenly
   * across the whole clip. Kept as a string so the runner controls the
   * exact expression and this fn stays pure.
   */
  fps: string;
}

/**
 * Build the ffmpeg args for generating a timeline filmstrip sprite — a single
 * horizontal JPG of `frames` frames sampled evenly across the clip.
 *
 * The `fps`-based sample is robust on variable-length clips (unlike a
 * `select='not(mod(n,FLOOR))'` modulo, which over/under-samples when the
 * frame count isn't a clean multiple). The runner computes `fps =
 * frames / duration` from an ffprobe pass and threads it here.
 *
 * Filtergraph: `fps=<fps>` decimates to ~`frames` frames → `scale=-2:H`
 * shrinks each to height H (width even, aspect-preserved) → `tile=NxN`
 * assembles a single Nx1 horizontal strip. `-frames:v 1` emits exactly the
 * one assembled sprite.
 */
export function buildFilmstripArgs(
  inputPath: string,
  outputPath: string,
  opts: BuildFilmstripOptions,
): string[] {
  const frames = Math.max(1, Math.round(opts.frames));
  const height = Math.max(1, Math.round(opts.height));
  return [
    "-y",
    "-i", inputPath,
    "-vf", `fps=${opts.fps},scale=-2:${height},tile=${frames}x1`,
    "-frames:v", "1",
    outputPath,
  ];
}
