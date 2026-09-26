import { probeMediaResult, readOpusDiscards } from "@/lib/ffmpeg/probe";
import { audioProxyReason, previewPrefersProxy } from "@/lib/ffmpeg/audio-preview";

/**
 * What the preview needs to put a file's audio and video on ffmpeg's
 * timeline: the body of `GET /api/files/by-id/<id>/timing` (see that route
 * for each field), read by `lib/engine/source-time-origin.ts`.
 */
export interface FileTiming {
  startTime: number | null;
  audioCodecDelay: number;
  audioPadding: number;
  audioStart: number | null;
  oggFirstPacket: number | null;
  oggFirstPacketDuration: number;
  opusTrims: Array<[number, number]>;
  preferProxyAudio: boolean;
}

/** The file's timing; null when the probe failed (timeout, ffprobe missing): not an answer. */
export async function fileTiming(filePath: string): Promise<FileTiming | null> {
  const probed = await probeMediaResult(filePath);
  if (!probed.ok) return null;
  const m = probed.media;
  return {
    startTime: m.startTime ?? null,
    audioCodecDelay: m.audioCodecDelay ?? 0,
    audioPadding: m.audioPadding ?? 0,
    audioStart: m.audioStart ?? null,
    oggFirstPacket: m.oggFirstPacket ?? null,
    oggFirstPacketDuration: m.oggFirstPacketDuration ?? 0,
    opusTrims:
      m.audioCodec === "opus" && /(^|,)matroska(,|$)/.test(m.formatName ?? "") && m.primaryAudioStreamIndex !== undefined
        ? await readOpusDiscards(filePath, m.primaryAudioStreamIndex)
        : [],
    preferProxyAudio: previewPrefersProxy(await audioProxyReason(filePath, m)),
  };
}
