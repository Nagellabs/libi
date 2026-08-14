/**
 * Alpha-awareness helpers — the single source of truth for "does this video
 * carry an alpha channel?" and "which ffmpeg input flags preserve it?".
 *
 * Two ffmpeg gotchas make this load-bearing:
 *  1. WebM stores VP8/VP9 alpha as a side-band (BlockAdditional). ffmpeg's
 *     NATIVE vp9 decoder silently skips it — ffprobe even reports the stream
 *     as `yuv420p`. The honest container signal is the `alpha_mode` stream
 *     tag; the honest decode path is `-c:v libvpx-vp9` (an INPUT option,
 *     before `-i`).
 *  2. `alphamerge` (how matte_gen composes cutouts) keeps the original RGB
 *     planes intact — so dropping alpha does not fail loudly, it silently
 *     yields the ORIGINAL video with its background back.
 */

/** Video pixel formats that carry an alpha plane directly. */
const ALPHA_PIX_FMT_EXACT = new Set([
  "rgba",
  "bgra",
  "argb",
  "abgr",
  "ya8",
  "ya16le",
  "ya16be",
]);

export interface ProbedVideoStream {
  pix_fmt?: string;
  tags?: Record<string, string>;
}

/**
 * Read the WebM `alpha_mode` tag CASE-INSENSITIVELY.
 *
 * Muxers disagree on the key's case and ffprobe passes it through verbatim:
 * our own libvpx-vp9 encoder writes `alpha_mode`, while Bria's fal endpoint
 * writes `ALPHA_MODE`. A case-sensitive lookup therefore matched every file
 * libi produced and MISSED every alpha WebM arriving from a third party —
 * which then got an alpha-stripping H.264 proxy and rendered as the original
 * scene (the B1 defect, reintroduced via the import path).
 */
function alphaModeTag(tags?: Record<string, string>): string | undefined {
  if (!tags) return undefined;
  for (const [key, value] of Object.entries(tags)) {
    if (key.toLowerCase() === "alpha_mode") return value;
  }
  return undefined;
}

/**
 * True when an ffprobe video stream carries alpha — either directly in its
 * pixel format (yuva*, gbrap*, rgba, ...) or via the WebM `alpha_mode`
 * side-band tag (where pix_fmt lies as yuv420p).
 */
export function streamHasAlpha(stream: ProbedVideoStream): boolean {
  if (alphaModeTag(stream.tags) === "1") return true;
  const fmt = stream.pix_fmt;
  if (typeof fmt !== "string") return false;
  return (
    fmt.startsWith("yuva") ||
    fmt.startsWith("gbrap") ||
    ALPHA_PIX_FMT_EXACT.has(fmt)
  );
}

export interface AlphaDecodeOpts {
  hasAlpha?: boolean | null;
  /** ffprobe `codec_name` of the video stream (e.g. "vp9", "vp8"). */
  videoCodec?: string | null;
}

export interface AlphaPreviewOpts extends AlphaDecodeOpts {
  /** Container fallbacks for probe-less call sites (the `files` row stores no
   * codec): VPx alpha lives in WebM; every other alpha carrier we know of
   * (ProRes 4444, qtrle, PNG-in-MOV) does not. */
  filename?: string | null;
  contentType?: string | null;
}

/**
 * The ONE decision point for "must this alpha-bearing file avoid a proxy?" —
 * used by the proxy_gen runner refusal, the boot backfill's proxy drop, the
 * storeFile enqueue gate, the clone-piece proxy carry, and `pickVideoUrl`.
 *
 * True only for the VPx-in-WebM family: preview can actually recover that
 * alpha by serving the ORIGINAL (WebCodecs decodes VP8/VP9), so an H.264
 * yuv420p proxy — which strips the alpha plane while `alphamerge` left the
 * original RGB planes intact — would silently show the original video with
 * its background back (the B1 defect). For every OTHER alpha format (ProRes
 * 4444, qtrle, PNG-in-MOV) preview generally cannot decode the original at
 * all, so an OPAQUE scrub proxy is strictly better than no preview — those
 * files keep/get a proxy. Fidelity is unaffected either way: server-side
 * ffmpeg exports read the ORIGINAL file (the original-file invariant).
 *
 * Signal precedence: a probed `videoCodec` wins; without one we fall back to
 * the WebM container signal (contentType, then filename extension).
 */
export function alphaRecoverableInPreview(opts: AlphaPreviewOpts): boolean {
  if (!opts.hasAlpha) return false;
  const codec = opts.videoCodec;
  if (typeof codec === "string" && codec.length > 0) {
    return codec === "vp8" || codec === "vp9";
  }
  if (opts.contentType === "video/webm") return true;
  return (opts.filename ?? "").toLowerCase().endsWith(".webm");
}

/**
 * ffmpeg INPUT options (place immediately before the `-i <file>` they apply
 * to) that make the decode alpha-preserving. Only the VPx-in-WebM family
 * needs a forced decoder — native decoders for prores/qtrle/png keep their
 * alpha already. Returns `[]` for opaque files.
 */
export function vpxAlphaDecodeArgs(opts: AlphaDecodeOpts): string[] {
  if (!opts.hasAlpha) return [];
  if (opts.videoCodec === "vp9") return ["-c:v", "libvpx-vp9"];
  if (opts.videoCodec === "vp8") return ["-c:v", "libvpx"];
  return [];
}
