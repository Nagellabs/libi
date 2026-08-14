/**
 * Pure ffmpeg-args builder for `libi.generate_thumbnails` single-frame
 * extraction (op `generate_thumbnail`).
 *
 * The alpha path exists because a thumbnail is the agent's mandatory
 * verify-pixels surface for background-removal cutouts: decoded natively, a
 * VP9-alpha WebM yields the FULL ORIGINAL FRAME (see `lib/ffmpeg/alpha.ts`),
 * which reports a *correct* cutout as "the feature did nothing". Alpha
 * sources are therefore decoded alpha-preserving and composited over SOLID
 * MAGENTA — a JPG can't show transparency, but "background replaced by flat
 * magenta" is an unambiguous, decoder-independent rubric.
 */
import { vpxAlphaDecodeArgs } from "@/lib/ffmpeg/alpha";

export interface ThumbnailArgsOptions {
  sourcePath: string;
  outPath: string;
  /** Seek target in seconds (input-side `-ss`). */
  time: number;
  /** Present iff the source carries alpha; `videoCodec` picks the decoder. */
  alpha: { videoCodec?: string | null } | null;
}

/**
 * Composite the (alpha-preserving) decoded frame over solid magenta: split
 * the frame, fill one copy edge-to-edge with magenta (same size, no second
 * input needed), overlay the original on top so transparency shows magenta.
 */
const ALPHA_OVER_MAGENTA_GRAPH =
  "[0:v]format=rgba,split[fg][bgsrc];" +
  "[bgsrc]drawbox=color=magenta:t=fill[bg];" +
  "[bg][fg]overlay=format=auto";

export function buildThumbnailArgs(opts: ThumbnailArgsOptions): string[] {
  const seekAndInput = [
    "-ss", String(opts.time),
    ...(opts.alpha
      ? vpxAlphaDecodeArgs({ hasAlpha: true, videoCodec: opts.alpha.videoCodec })
      : []),
    "-i", opts.sourcePath,
  ];
  if (!opts.alpha) {
    return [
      "-y",
      ...seekAndInput,
      "-frames:v", "1",
      "-q:v", "4",
      opts.outPath,
    ];
  }
  return [
    "-y",
    ...seekAndInput,
    "-filter_complex", ALPHA_OVER_MAGENTA_GRAPH,
    "-frames:v", "1",
    "-q:v", "4",
    opts.outPath,
  ];
}
