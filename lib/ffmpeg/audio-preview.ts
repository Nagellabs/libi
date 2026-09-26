import { open } from "node:fs/promises";
import type { ProbedMedia } from "@/lib/ffmpeg/probe";

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
 * A video file has a proxy anyway; this decides it for an audio file, and
 * tells the preview to prefer the proxy where mediabunny misreads without
 * failing (`previewPrefersProxy`).
 */
export type AudioProxyReason = "chained-ogg" | "ogg-flac" | "codec";

/**
 * ffprobe codec names the preview decodes: WebCodecs in Chromium (Electron)
 * for the compressed ones, mediabunny's own PCM decoder for the rest.
 */
const PREVIEW_AUDIO_CODEC = /^(aac|mp3|opus|vorbis|flac|pcm_(s|u|f)(8|16|24|32|64)(le|be)?(_planar)?|pcm_(alaw|mulaw))$/;

const OGG = /(^|,)ogg(,|$)/;

export async function audioProxyReason(
  filePath: string,
  probed: Pick<ProbedMedia, "hasAudio" | "audioCodec" | "formatName">,
): Promise<AudioProxyReason | null> {
  if (!probed.hasAudio || !probed.audioCodec) return null;
  const ogg = OGG.test(probed.formatName ?? "");
  if (ogg && probed.audioCodec === "flac") return "ogg-flac";
  if (!PREVIEW_AUDIO_CODEC.test(probed.audioCodec)) return "codec";
  if (ogg && (await oggIsChained(filePath))) return "chained-ogg";
  return null;
}

/** Reasons mediabunny reads wrongly without failing: the preview switches to the proxy at once. */
export function previewPrefersProxy(reason: AudioProxyReason | null): boolean {
  return reason === "chained-ogg" || reason === "ogg-flac";
}

/**
 * True when an Ogg file starts a new stream after data of an earlier one: a
 * beginning-of-stream page after a page that isn't one. (A file's own
 * streams all begin on its first pages, so several streams read together,
 * audio and video, are not a chain.) Reads only page headers; a file that
 * isn't Ogg, or ends mid-page, is not chained.
 */
export async function oggIsChained(filePath: string): Promise<boolean> {
  const fh = await open(filePath, "r").catch(() => null);
  if (!fh) return false;
  try {
    const size = (await fh.stat()).size;
    const header = Buffer.alloc(27);
    const lacing = Buffer.alloc(255);
    let offset = 0;
    let seenData = false;
    while (offset + 27 <= size) {
      const { bytesRead } = await fh.read(header, 0, 27, offset);
      if (bytesRead < 27 || header.toString("latin1", 0, 4) !== "OggS") return false;
      const bos = (header[5] & 0x02) !== 0;
      if (bos && seenData) return true;
      if (!bos) seenData = true;
      const segments = header[26];
      await fh.read(lacing, 0, segments, offset + 27);
      let body = 0;
      for (let i = 0; i < segments; i++) body += lacing[i];
      offset += 27 + segments + body;
    }
    return false;
  } finally {
    await fh.close();
  }
}
