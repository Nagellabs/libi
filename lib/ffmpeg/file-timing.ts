import { probeMediaResult, readOpusDiscards, type OpusDiscardsResult } from "@/lib/ffmpeg/probe";
import { audioProxyVerdict, previewPrefersProxy } from "@/lib/ffmpeg/audio-preview";

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

/**
 * A timing answer, and whether it may be cached. Not cacheable when a part of
 * it could not be read and was answered as empty: an Opus Matroska file's
 * trims whose whole-stream read failed or timed out (review round 5, M5).
 */
export type FileTimingAnswer = FileTiming & { cacheable: boolean };

/** The file's timing; null when the probe failed (timeout, ffprobe missing): not an answer. */
export async function fileTiming(filePath: string): Promise<FileTimingAnswer | null> {
  const probed = await probeMediaResult(filePath);
  if (!probed.ok) return null;
  const m = probed.media;
  const discards: OpusDiscardsResult =
    m.audioCodec === "opus" && /(^|,)matroska(,|$)/.test(m.formatName ?? "") && m.primaryAudioStreamIndex !== undefined
      ? await readOpusDiscards(filePath, m.primaryAudioStreamIndex)
      : { ok: true, trims: [] };
  // An HE-AAC check that couldn't run (timeout) is served as "no" but never
  // remembered: the next request asks again (review I2).
  const verdict = await audioProxyVerdict(filePath, m);
  return {
    startTime: m.startTime ?? null,
    audioCodecDelay: m.audioCodecDelay ?? 0,
    audioPadding: m.audioPadding ?? 0,
    audioStart: m.audioStart ?? null,
    oggFirstPacket: m.oggFirstPacket ?? null,
    oggFirstPacketDuration: m.oggFirstPacketDuration ?? 0,
    opusTrims: discards.ok ? discards.trims : [],
    preferProxyAudio: previewPrefersProxy(verdict.reason),
    cacheable: discards.ok && !verdict.unknown,
  };
}
