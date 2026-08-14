export interface BuildProxyOptions {
  /** Source fps. GOP size = fps (one keyframe per second). */
  fps: number;
}

/**
 * Build the ffmpeg args for generating a scrub-friendly preview proxy.
 *
 * Target: resolution-aware H.264 yuv420p, 1 keyframe/sec, faststart for
 * streaming. CRF 23 is a sensible quality/size balance for editing.
 *
 * Proxy height = `min(sourceHeight, 1080)`:
 *   - ≤1080p sources (essentially all AI-generated clips) are re-encoded at
 *     their **native resolution** — scrub-friendly GOP, zero visible downgrade.
 *   - >1080p sources (e.g. 4K uploads) are downscaled to 1080p.
 */
export function buildProxyArgs(
  inputPath: string,
  outputPath: string,
  opts: BuildProxyOptions,
): string[] {
  const gop = Math.max(1, Math.round(opts.fps));
  return [
    "-y",
    "-i", inputPath,
    // Height-capped at 1080, aspect preserved, and BOTH output dimensions rounded
    // down to an even integer — libx264/yuv420p rejects odd width OR height with
    // "Could not open encoder … Invalid argument". The previous
    // `min(iw,trunc(iw*1080/ih/2)*2)` form only rounded the DOWNSCALE branch: a
    // ≤1080p source kept its native `iw`/`ih` untouched, so any odd-width source
    // (e.g. an 853×480 clip) failed proxy generation outright. Deriving the
    // target height first (`min(ih,1080)`), scaling width to match, then
    // even-truncating each keeps aspect, never upscales, and is always even.
    "-vf", "scale='trunc(iw*min(ih,1080)/ih/2)*2':'trunc(min(ih,1080)/2)*2'",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "23",
    "-g", String(gop),
    "-keyint_min", String(gop),
    "-sc_threshold", "0",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    outputPath,
  ];
}
