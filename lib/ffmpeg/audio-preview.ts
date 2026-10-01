import { execFile } from "child_process";
import path from "path";
import { open } from "node:fs/promises";
import { promisify } from "util";
import type { ProbedMedia } from "@/lib/ffmpeg/probe";
import { resolveFfprobePath } from "@/lib/ffmpeg/exec";
import { parseAacAudioSpecificConfig } from "@/lib/audio/he-aac-config";
import { proxyLogger as logger } from "@/lib/logger";

const exec = promisify(execFile);

/**
 * Whether the preview can play a file's audio itself, or needs an AAC proxy
 * of it (the fallback the preview's audio engine already switches to when an
 * original can't be decoded: lib/audio/web-audio-engine.ts). Review round 4:
 * the preview played silence for these, while the export plays them:
 * - `chained-ogg`: an Ogg file of several streams one after another (a radio
 *   rip, `cat a.ogg b.ogg`). mediabunny reads the first and stops: silence
 *   after it. ffmpeg plays them all.
 * - `ogg-flac`: FLAC in Ogg. mediabunny lists no track at all.
 * - `codec`: a codec neither WebCodecs in Chromium nor mediabunny decodes
 *   (ALAC, AC-3, E-AC-3, DTS, WMA, AMR, ...).
 * - `he-aac-mono`: an audio-only AAC file whose MONO core carries SBR/PS
 *   (AUD-4). Chromium decodes that to stereo, so the 1-channel config the
 *   track reports fails WebCodecs. The preview repairs the config when the
 *   AudioSpecificConfig SIGNALS SBR (lib/audio/he-aac-config.ts), but a
 *   stream that carries it in-band only (an LC-signalled ASC; every HE-AAC
 *   ADTS .aac) can't be seen there, and an audio file had no proxy to fall
 *   back to: silence (docs-local/qa/2026-09-25-dreams-audio-report.md,
 *   concern 1). A video has its proxy anyway, so only audio-only files.
 * A video file has a proxy anyway; this decides it for an audio file, and
 * tells the preview to prefer the proxy where mediabunny misreads without
 * failing (`previewPrefersProxy`).
 */
export type AudioProxyReason = "chained-ogg" | "ogg-flac" | "codec" | "he-aac-mono";

/**
 * ffprobe codec names the preview decodes: WebCodecs in Chromium (Electron)
 * for the compressed ones, mediabunny's own PCM decoder for the rest.
 */
const PREVIEW_AUDIO_CODEC = /^(aac|mp3|opus|vorbis|flac|pcm_(s|u|f)(8|16|24|32|64)(le|be)?(_planar)?|pcm_(alaw|mulaw))$/;

const OGG = /(^|,)ogg(,|$)/;

/**
 * Whether an audio file of this name may need a preview proxy, so is worth a
 * probe: an MP3 or FLAC file holds only its own codec, which the preview
 * plays. An ADTS .aac is probed (AUD-4): it may be HE-AAC on a mono core,
 * which ADTS can only carry in-band. storeFile and the boot sweep
 * (lib/proxy/regen-audio-preview.ts) use the same rule, so the sweep never
 * probes a file the upload wouldn't have (review round 5, M4), and so does
 * the re-make on open (lib/proxy/ensure.ts).
 */
export function mayNeedAudioPreviewProxy(filename: string): boolean {
  return !/\.(mp3|flac)$/i.test(filename);
}

type ProbedForAudioPreview = Pick<ProbedMedia, "hasAudio" | "audioCodec" | "formatName"> &
  Partial<Pick<ProbedMedia, "primaryAudioStreamIndex" | "primaryVideoStreamIndex">>;

/**
 * The preview-proxy decision, and whether it is CERTAIN. `unknown` is true
 * when a probe the decision needed failed or timed out (review I2): the
 * answer `reason: null` is then a guess, not a "no". Callers must not
 * remember it (the timing route's cache, the boot sweep's marker) and the
 * upload makes the proxy anyway — a spare proxy costs a transcode, a missing
 * one is a silent preview.
 */
export interface AudioProxyVerdict {
  reason: AudioProxyReason | null;
  unknown: boolean;
}

export async function audioProxyVerdict(
  filePath: string,
  probed: ProbedForAudioPreview,
): Promise<AudioProxyVerdict> {
  if (!probed.hasAudio || !probed.audioCodec) return { reason: null, unknown: false };
  const ogg = OGG.test(probed.formatName ?? "");
  if (ogg && probed.audioCodec === "flac") return { reason: "ogg-flac", unknown: false };
  if (!PREVIEW_AUDIO_CODEC.test(probed.audioCodec)) return { reason: "codec", unknown: false };
  if (ogg && (await oggIsChained(filePath))) return { reason: "chained-ogg", unknown: false };
  if (probed.audioCodec === "aac" && probed.primaryVideoStreamIndex === undefined) {
    const heAac = await aacSbrOnMonoCore(filePath, probed.primaryAudioStreamIndex);
    if (heAac === "unknown") return { reason: null, unknown: true };
    if (heAac) return { reason: "he-aac-mono", unknown: false };
  }
  return { reason: null, unknown: false };
}

/** `audioProxyVerdict`'s reason alone (an unknown reads as null). */
export async function audioProxyReason(
  filePath: string,
  probed: ProbedForAudioPreview,
): Promise<AudioProxyReason | null> {
  return (await audioProxyVerdict(filePath, probed)).reason;
}

/**
 * Reasons the preview should go to the proxy at once: mediabunny reads the
 * two Ogg cases wrongly without failing, and an HE-AAC mono core fails only
 * once decoding starts (asynchronously), mid-playback.
 */
export function previewPrefersProxy(reason: AudioProxyReason | null): boolean {
  return reason === "chained-ogg" || reason === "ogg-flac" || reason === "he-aac-mono";
}

/** Bound on the one ffprobe call that reads an AAC stream's profile and ASC. */
const AAC_PROBE_TIMEOUT_MS = 15_000;

/**
 * True when the AAC stream decodes as SBR/PS over a MONO core. Two sources,
 * either one suffices:
 * - the AudioSpecificConfig, read by the same parser the preview's HE-AAC
 *   repair uses (`parseAacAudioSpecificConfig`): SBR or PS signalled on a
 *   1-channel core;
 * - ffprobe's `profile`, which comes from DECODING, so it sees in-band SBR an
 *   LC-signalled ASC hides: "HE-AACv2" (PS, or ffmpeg's assumption for
 *   implicit SBR on a mono core; either way a mono core), or "HE-AAC" over an
 *   ASC whose core is mono. ADTS has no ASC: its "HE-AACv2" decides.
 * A failed or timed-out probe answers "unknown" (logged), never false.
 */
async function aacSbrOnMonoCore(filePath: string, streamIndex: number | undefined): Promise<boolean | "unknown"> {
  let stream: { profile?: unknown; extradata?: unknown } | undefined;
  try {
    const { stdout } = await exec(
      resolveFfprobePath(),
      [
        "-v", "quiet",
        "-select_streams", streamIndex !== undefined ? String(streamIndex) : "a:0",
        "-show_entries", "stream=profile,extradata",
        "-show_data",
        "-of", "json",
        filePath,
      ],
      { timeout: AAC_PROBE_TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true },
    );
    stream = (JSON.parse(stdout) as { streams?: Array<{ profile?: unknown; extradata?: unknown }> }).streams?.[0];
  } catch (err) {
    const e = err as { killed?: boolean; signal?: string; message?: string } | null;
    logger.warn(
      {
        tag: "proxy",
        op: "aac_profile_probe_failed",
        file: path.basename(filePath),
        timedOut: e?.killed === true || e?.signal === "SIGKILL",
        err: e?.message ?? String(err),
      },
      "proxy.aac_profile_probe_failed — HE-AAC check unknown; not remembered",
    );
    return "unknown";
  }
  if (!stream) return false;
  const asc = typeof stream.extradata === "string" ? hexdumpBytes(stream.extradata) : null;
  const config = asc && asc.length >= 2 ? parseAacAudioSpecificConfig(asc) : null;
  const monoCore = config?.coreChannels === 1;
  if (monoCore && (config.sbrSampleRate !== null || config.psPresent)) return true;
  if (stream.profile === "HE-AACv2") return true;
  return stream.profile === "HE-AAC" && monoCore;
}

/** ffprobe's `-show_data` hexdump (`00000000: 1388 56e5 a0   ..V..`) → bytes. */
function hexdumpBytes(dump: string): Uint8Array | null {
  const hex = dump
    .split("\n")
    .map((line) => /^[0-9a-f]{8}: /i.test(line) ? line.slice(10, 50).replace(/\s+/g, "") : "")
    .join("");
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/** Bytes at the end of an Ogg file searched for a later chain's pages. */
const OGG_TAIL_BYTES = 64 * 1024;
/** Backstop on the pages read from the start (the first chain's opening pages). */
const OGG_MAX_HEAD_PAGES = 2000;

// Ogg's page CRC: polynomial 0x04c11db7, not reflected, initial value 0.
const OGG_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

/** Whether `buf` holds a whole, valid Ogg page at `at` (capture pattern, version, CRC). */
function validPageAt(buf: Buffer, at: number): boolean {
  if (at + 27 > buf.length || buf[at + 4] !== 0 || (buf[at + 5] & ~0x07) !== 0) return false;
  const segments = buf[at + 26];
  if (at + 27 + segments > buf.length) return false;
  let body = 0;
  for (let i = 0; i < segments; i++) body += buf[at + 27 + i];
  const end = at + 27 + segments + body;
  if (end > buf.length) return false;
  let c = 0;
  for (let i = at; i < end; i++) {
    const b = i >= at + 22 && i < at + 26 ? 0 : buf[i]; // the CRC field counts as zero
    c = ((c << 8) ^ OGG_CRC_TABLE[((c >>> 24) ^ b) & 0xff]) >>> 0;
  }
  return c === buf.readUInt32LE(at + 22);
}

/**
 * True when an Ogg file starts a new stream after data of an earlier one: a
 * chain (a radio rip, `cat a.ogg b.ogg`). A file's own streams all begin on
 * its first pages (every beginning-of-stream page comes before any data), so
 * several streams read together, audio and video, are not a chain.
 *
 * Bounded (review round 5, M6: it walked every page header, ~100k reads for
 * a 1 GB audiobook):
 * - from the start, the first chain's beginning-of-stream pages up to its
 *   first other page: the serials it opens (a backstop of
 *   `OGG_MAX_HEAD_PAGES`);
 * - then ONE read of the last `OGG_TAIL_BYTES`, where any whole page with a
 *   valid CRC that opens a stream, or belongs to a stream the first chain
 *   didn't open, is a later chain's. The end of a file is always its last
 *   chain, so a second chain of any length is found by its serial.
 * Missed: a later chain that reuses the first one's serial (two `-fflags
 * +bitexact` encodes) and whose opening page is not in the tail.
 * A file that isn't Ogg, or ends mid-page, is not chained.
 */
export async function oggIsChained(filePath: string): Promise<boolean> {
  const fh = await open(filePath, "r").catch(() => null);
  if (!fh) return false;
  try {
    const size = (await fh.stat()).size;
    const header = Buffer.alloc(27);
    const lacing = Buffer.alloc(255);
    const serials = new Set<number>();
    let offset = 0;
    let reachedData = false;
    for (let pages = 0; pages < OGG_MAX_HEAD_PAGES && offset + 27 <= size; pages++) {
      const { bytesRead } = await fh.read(header, 0, 27, offset);
      if (bytesRead < 27 || header.toString("latin1", 0, 4) !== "OggS") return false;
      if ((header[5] & 0x02) === 0) {
        reachedData = true;
        break;
      }
      serials.add(header.readUInt32LE(14));
      const segments = header[26];
      await fh.read(lacing, 0, segments, offset + 27);
      let body = 0;
      for (let i = 0; i < segments; i++) body += lacing[i];
      offset += 27 + segments + body;
    }
    if (!reachedData || serials.size === 0) return false;

    const tailStart = Math.max(offset, size - OGG_TAIL_BYTES);
    const tail = Buffer.alloc(size - tailStart);
    const { bytesRead } = await fh.read(tail, 0, tail.length, tailStart);
    const buf = tail.subarray(0, bytesRead);
    for (let at = buf.indexOf("OggS", 0, "latin1"); at !== -1; at = buf.indexOf("OggS", at + 1, "latin1")) {
      if (!validPageAt(buf, at)) continue;
      if ((buf[at + 5] & 0x02) !== 0 || !serials.has(buf.readUInt32LE(at + 14))) return true;
    }
    return false;
  } finally {
    await fh.close();
  }
}
