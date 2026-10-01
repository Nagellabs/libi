/**
 * The two ffmpeg ops behind publishing: the example video (H.264/AAC MP4,
 * ≤ 15 s, ≤ 1280 on the long edge, ≤ 8 MB — retried once at a higher CRF
 * and a capped bitrate when the first pass lands over the size cap) and the
 * poster (one JPEG at 1.0 s, or half-way into a shorter example, ≤ 400 KB,
 * retried once at a lower quality). Fixed `op` strings, as every runFfmpeg
 * caller uses.
 *
 * The example is READ BACK after every encode and must pass the same checks
 * the site makes on what it is told (libi-site lib/templates/prepare.ts):
 * `durationSec` — ffprobe's format duration — at most 15 s exactly, a video
 * stream, the long edge ≤ 1280. `-t 15` alone is not enough: it keeps every
 * frame that STARTS before 15 s, and at 29.97 fps the last one ends at
 * 15.015 s. So the trim is one frame's length short of the cap, and an
 * output that still overshoots (a VFR source whose average rate understates
 * its longest frame) is re-encoded shorter by the overshoot, once.
 *
 * Both outputs are published to strangers, so the example drops the source's
 * metadata (a phone recording carries its GPS location), chapters, subtitles
 * and data streams.
 *
 * An alpha-bearing source is FLATTENED ONTO BLACK, never refused and never
 * left to ffmpeg: H.264 and JPEG have no alpha plane, and simply dropping it
 * shows whatever colour sits under the transparent pixels — for a cutout
 * made with `alphamerge`, the original background the user removed. The
 * frame is premultiplied by its alpha (transparent → black) before scaling,
 * and a VP8/VP9 WebM is decoded with libvpx, the only decoder that reads its
 * side-band alpha (lib/ffmpeg/alpha.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { vpxAlphaDecodeArgs, type AlphaDecodeOpts } from "@/lib/ffmpeg/alpha";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { probeMedia, probeMediaResult, type ProbedMedia, type ProbeFailure } from "@/lib/ffmpeg/probe";
import { CAPS, EXAMPLE_MAX_LONG_EDGE, EXAMPLE_MAX_SECONDS, EXAMPLE_MIN_SECONDS } from "@/lib/templates/cloud/constants";

export const EXAMPLE_OP = "template_example";
export const POSTER_OP = "template_poster";
const CRF_FIRST = 26;
const CRF_RETRY = 32;
/** 4 Mbit/s × 15 s + 96 kbit/s audio ≈ 7.7 MB: the size retry fits the 8 MB cap by construction. */
const RETRY_MAXRATE = ["-maxrate", "4M", "-bufsize", "8M"];
const POSTER_Q_FIRST = 5;
const POSTER_Q_RETRY = 12;
const POSTER_SEEK_SEC = 1;
/** Frame length assumed when the source's rate is unknown: a 10 fps frame. */
const FALLBACK_FRAME_SEC = 0.1;
/** Extra margin taken off the trim when a read-back overshoots, on top of the overshoot. */
const OVERSHOOT_MARGIN_SEC = 0.02;

/** Round down to the nearest even integer, in ffmpeg's expression language. */
const even = (expr: string) => `trunc(${expr}/2)*2`;
/**
 * Long edge to ≤ 1280 (never upscaled) and EVEN, the other edge to the nearest
 * even value: libx264 at yuv420p refuses an odd width or height, and an odd
 * source ≤ 1280 (721×405, 1001×1001) keeps its odd edge through `min()`.
 */
const SCALE = `scale='if(gt(iw,ih),${even(`min(${EXAMPLE_MAX_LONG_EDGE},iw)`)},-2)':'if(gt(iw,ih),-2,${even(`min(${EXAMPLE_MAX_LONG_EDGE},ih)`)})'`;
/** Composite over black: RGB × alpha, so a transparent pixel is black whatever colour it held. */
const FLATTEN_ALPHA = "format=rgba,premultiply=inplace=1";
/**
 * Square the pixels first. An anamorphic source (DV/DVD 720×480 at SAR 8:9,
 * HDV 1440×1080 at 4:3) is SHOWN at `iw*sar` × `ih`; scaling the stored size
 * would cap the wrong edge, and the poster — a JPEG, which no player
 * stretches — would come out squashed. An unknown SAR (0) leaves the width.
 */
const SQUARE_PIXELS = "scale=iw*sar:ih,setsar=1";
/** Tag the output square too: `scale` keeps the display aspect by adjusting the SAR it writes. */
const SQUARE_OUTPUT = "setsar=1";

/**
 * The input options and the video filter for a source, flattening its alpha
 * when it has one. The flatten comes FIRST, before any resample — the
 * anamorphic squaring included: scaling straight alpha blends the colour
 * hidden under transparent pixels into the edges (a halo); premultiplied, it
 * is black and blends as black. `premultiply` keeps the SAR the squaring reads.
 */
function sourceArgs(alpha: AlphaDecodeOpts | undefined): { decode: string[]; vf: string } {
  if (!alpha?.hasAlpha) return { decode: [], vf: `${SQUARE_PIXELS},${SCALE},${SQUARE_OUTPUT}` };
  return { decode: vpxAlphaDecodeArgs(alpha), vf: `${FLATTEN_ALPHA},${SQUARE_PIXELS},${SCALE},${SQUARE_OUTPUT}` };
}

/** Seconds as an ffmpeg time, rounded DOWN to the millisecond so a trim never grows. */
const secs = (s: number) => String(Math.floor(s * 1000) / 1000);

export interface ExamplePass {
  crf: number;
  /** `-t`: how much of the source to keep. */
  trimSec: number;
  /** Cap the bitrate too (the size retry). */
  capBitrate?: boolean;
  /**
   * Leave the audio out entirely (`-an`). The example is public: its caller
   * sets this when the source may carry a copyrighted song
   * (`template_publish_prepare`, social-music spec §7).
   */
  dropAudio?: boolean;
}

export function buildExampleArgs(input: string, output: string, pass: ExamplePass, alpha?: AlphaDecodeOpts): string[] {
  const { decode, vf } = sourceArgs(alpha);
  return [
    "-y", ...decode, "-i", input,
    "-t", secs(pass.trimSec),
    "-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn",
    "-vf", vf,
    "-c:v", "libx264", "-preset", "medium", "-crf", String(pass.crf), "-pix_fmt", "yuv420p",
    ...(pass.capBitrate ? RETRY_MAXRATE : []),
    "-movflags", "+faststart",
    ...(pass.dropAudio ? ["-an"] : ["-c:a", "aac", "-b:a", "96k", "-ac", "2"]),
    "-f", "mp4", output,
  ];
}

/** One JPEG frame at `seekSec`, written as a single file (`-update 1`: no `%d` sequence pattern in the name). */
export function buildPosterArgs(input: string, output: string, quality: number, seekSec: number, alpha?: AlphaDecodeOpts): string[] {
  const { decode, vf } = sourceArgs(alpha);
  return [
    "-y", "-ss", secs(seekSec), ...decode, "-i", input,
    "-frames:v", "1", "-vf", vf, "-c:v", "mjpeg", "-q:v", String(quality),
    "-f", "image2", "-update", "1", output,
  ];
}

export interface ExampleResult {
  path: string;
  bytes: number;
  durationSec: number;
  width: number;
  height: number;
}

/**
 * Both paths are positional ffmpeg args: a relative one could start with `-`
 * (read as an option) or be `proto:…` (opened as a URL). Callers pass
 * server-built absolute paths; anything else is a bug, refused here.
 */
function assertAbsolute(...paths: string[]): void {
  for (const p of paths) {
    if (!path.isAbsolute(p)) throw new Error(`publish media: "${p}" must be an absolute path`);
  }
}

const PROBE_FAILURE_MESSAGE: Record<ProbeFailure, string> = {
  timeout: "ffprobe timed out on it",
  unreadable: "it is missing, unreadable or not a media file",
};

/**
 * The source's probe, or a throw saying what is wrong with it. A probe that
 * FAILED (timed out, or could not read the file) is reported as that — never
 * as "no video stream", which would send the agent looking for the wrong fix.
 */
async function probeSource(input: string): Promise<ProbedMedia> {
  const r = await probeMediaResult(input);
  if (!r.ok) throw new Error(`could not read the source video: ${PROBE_FAILURE_MESSAGE[r.failure]}`);
  if (!r.media.width || !r.media.height) throw new Error("the source has no video stream — a template example must be a video");
  return r.media;
}

/** The example as the site will judge it, or a throw naming the cap it misses. */
function checkedExample(output: string, out: ProbedMedia): ExampleResult {
  if (out.duration === undefined || !out.width || !out.height) {
    throw new Error("example video: could not read the encoded file back (no duration or no video stream)");
  }
  if (out.duration > EXAMPLE_MAX_SECONDS) {
    throw new Error(`example video came out at ${out.duration} s, over the ${EXAMPLE_MAX_SECONDS} s cap`);
  }
  if (out.duration < EXAMPLE_MIN_SECONDS) {
    throw new Error(`example video is ${out.duration} s long — it must be at least ${EXAMPLE_MIN_SECONDS} s`);
  }
  if (Math.max(out.width, out.height) > EXAMPLE_MAX_LONG_EDGE) {
    throw new Error(`example video came out at ${out.width}×${out.height}, over the ${EXAMPLE_MAX_LONG_EDGE} px long-edge cap`);
  }
  return { path: output, bytes: fs.statSync(output).size, durationSec: out.duration, width: out.width, height: out.height };
}

export async function transcodeExample(
  input: string,
  output: string,
  opts: { signal?: AbortSignal; onProgress?: (ratio: number) => void; dropAudio?: boolean } = {},
): Promise<ExampleResult> {
  assertAbsolute(input, output);
  const probe = await probeSource(input);
  let trimSec = EXAMPLE_MAX_SECONDS - (probe.frameRate ? 1 / probe.frameRate : FALLBACK_FRAME_SEC);
  // A retry restarts ffmpeg's own progress at 0; the caller's bar never goes back.
  let reported = 0;
  const onProgress = opts.onProgress && ((r: number) => {
    reported = Math.max(reported, r);
    opts.onProgress!(reported);
  });

  const encode = async (crf: number, capBitrate: boolean): Promise<ProbedMedia> => {
    await runFfmpeg(buildExampleArgs(input, output, { crf, trimSec, capBitrate, dropAudio: opts.dropAudio === true }, probe), {
      op: EXAMPLE_OP,
      context: { crf, trimSec, hasAlpha: probe.hasAlpha === true, dropAudio: opts.dropAudio === true },
      totalDurationSeconds: Math.min(probe.duration ?? trimSec, trimSec),
      onProgress,
      signal: opts.signal,
    });
    return probeMedia(output);
  };

  for (const crf of [CRF_FIRST, CRF_RETRY]) {
    const capBitrate = crf === CRF_RETRY;
    let out = await encode(crf, capBitrate);
    if (out.duration !== undefined && out.duration > EXAMPLE_MAX_SECONDS) {
      trimSec -= out.duration - EXAMPLE_MAX_SECONDS + OVERSHOOT_MARGIN_SEC;
      out = await encode(crf, capBitrate);
    }
    const result = checkedExample(output, out);
    if (result.bytes <= CAPS.example) return result;
  }
  throw new Error(`example video is over 8 MB even at CRF ${CRF_RETRY} — trim the source or lower its resolution`);
}

/**
 * An example made earlier (the publish request's own, prepared by
 * `transcodeExample`), read back and held to the same caps — what the publish
 * tells the site about it. Nothing is re-encoded.
 */
export async function readBackExample(file: string): Promise<ExampleResult> {
  assertAbsolute(file);
  const out = await probeMedia(file);
  const result = checkedExample(file, out);
  if (result.bytes > CAPS.example) throw new Error("example video is over 8 MB");
  return result;
}

export async function makePoster(input: string, output: string, opts: { signal?: AbortSignal } = {}): Promise<{ path: string; bytes: number }> {
  assertAbsolute(input, output);
  const probe = await probeSource(input);
  // The site takes examples from 0.1 s; a fixed 1.0 s seek finds no frame in one of a second or less.
  const seekSec = probe.duration !== undefined ? Math.min(POSTER_SEEK_SEC, probe.duration / 2) : POSTER_SEEK_SEC;
  for (const q of [POSTER_Q_FIRST, POSTER_Q_RETRY]) {
    // A leftover poster from an earlier publish must not pass for this run's frame.
    fs.rmSync(output, { force: true });
    await runFfmpeg(buildPosterArgs(input, output, q, seekSec, probe), {
      op: POSTER_OP,
      context: { q, seekSec, hasAlpha: probe.hasAlpha === true },
      signal: opts.signal,
    });
    if (!fs.existsSync(output)) throw new Error(`poster: the source has no frame at ${secs(seekSec)} s`);
    const bytes = fs.statSync(output).size;
    if (bytes <= CAPS.poster) return { path: output, bytes };
  }
  throw new Error("poster is over 400 KB even at low quality");
}
