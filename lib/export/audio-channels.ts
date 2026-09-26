import { probeMedia } from "@/lib/ffmpeg/probe";

/** ffprobes running at once for one export. A piece can have many clips;
 *  forking one ffprobe per clip in a single burst is needless load. */
export const CHANNEL_PROBE_CONCURRENCY = 4;

/** What the export mix needs to know about one input's audio. */
export interface InputAudio {
  /** Channel count of the primary audio stream; undefined = unknown. */
  channels?: number;
  /** ffprobe index of the primary audio stream (the one the preview plays);
   *  undefined = unknown, and the graph falls back to `[n:a]`. */
  stream?: number;
  /** false when the probe found NO audio stream (a silent video). Such an
   *  input must be left out of the mix: `[n:a]` would match nothing and fail
   *  the export. undefined = unknown (a failed probe); kept, as before. */
  hasAudio?: boolean;
  /** How to read this input's audio onto the file's timeline (ProbedMedia.audioRead). */
  read?: { inputArgs: string[]; ptsShift: number };
}

/**
 * Probe each ffmpeg input that feeds an export mix. The results feed
 * `buildAudioMixGraph`'s `inputChannels` and `inputAudioStream`, and the duck
 * sidechains' stream. A failed probe maps to an empty entry, which the graph
 * handles with filters that are safe for either layout.
 *
 * Channels: amix takes the FIRST input's layout, so without them a mono
 * narration listed first made a stereo piece export mono (Fix round 1).
 * Stream: the preview plays mediabunny's primary track (the first
 * default-flagged one), while a filter's `[n:a]` takes the first audio stream,
 * so a multi-track file could export a different track than the one heard in
 * the editor (Review M6).
 *
 * At most CHANNEL_PROBE_CONCURRENCY probes run at once, each bounded by
 * probeMedia's own timeout.
 */
export async function probeInputAudio(
  paths: Map<number, string>,
  probe: (path: string) => Promise<{
    audioChannels?: number;
    primaryAudioStreamIndex?: number;
    hasAudio?: boolean;
    audioRead?: { inputArgs: string[]; ptsShift: number };
  }> = probeMedia,
): Promise<Map<number, InputAudio>> {
  const queue = [...paths];
  const out = new Map<number, InputAudio>();
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [idx, path] = next;
      const probed = await probe(path);
      out.set(idx, {
        ...(probed.audioChannels !== undefined ? { channels: probed.audioChannels } : {}),
        ...(probed.primaryAudioStreamIndex !== undefined ? { stream: probed.primaryAudioStreamIndex } : {}),
        ...(probed.hasAudio !== undefined ? { hasAudio: probed.hasAudio } : {}),
        ...(probed.audioRead ? { read: probed.audioRead } : {}),
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHANNEL_PROBE_CONCURRENCY, queue.length) }, worker));
  return out;
}

/** Split probeInputAudio's result into the maps buildAudioMixGraph takes. */
export function mixInputMaps(audio: Map<number, InputAudio>): {
  inputChannels: Map<number, number | undefined>;
  inputAudioStream: Map<number, number>;
  inputPtsShift: Map<number, number>;
} {
  const inputChannels = new Map<number, number | undefined>();
  const inputAudioStream = new Map<number, number>();
  const inputPtsShift = new Map<number, number>();
  for (const [idx, a] of audio) {
    inputChannels.set(idx, a.channels);
    if (a.stream !== undefined) inputAudioStream.set(idx, a.stream);
    if (a.read && a.read.ptsShift !== 0) inputPtsShift.set(idx, a.read.ptsShift);
  }
  return { inputChannels, inputAudioStream, inputPtsShift };
}
