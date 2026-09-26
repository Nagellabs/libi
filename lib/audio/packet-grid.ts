import { EncodedPacketSink, MatroskaInputFormat, type InputAudioTrack } from "mediabunny";

/**
 * A Matroska audio track of fixed-length frames (AAC, MP3): where each run's
 * audio truly starts.
 *
 * Matroska stores packet times in whole ms, so a run placed by its first
 * packet's stored time was up to 0.5 ms off ffmpeg's decode (measured ±0.33
 * ms on AAC in MKV, review round 4). ffmpeg decodes the track's samples back
 * to back from its first packet's time, so every packet truly starts a whole
 * number of frames after the first one: the nearest such point to its stored
 * time is it (the frames are 21 to 46 ms long; the stored time is within
 * 0.5 ms), counted from where ffmpeg has that first packet (`gridShift`).
 * Opus and Vorbis have their own placement (opus-seek.ts, vorbis-run.ts);
 * other containers store exact times.
 */
export interface PacketGrid {
  /** mediabunny timestamp of the track's first packet. */
  first: number;
  /** Seconds per packet. */
  frame: number;
}

/** Samples per packet of the fixed-frame codecs: AAC (1024; 2048 at HE-AAC's output rate), MP3 (1152; 576 for MPEG-2). */
const FRAME_SAMPLES = [576, 1024, 1152, 2048];

/** Packets read to find and check the frame length. */
const SAMPLE_PACKETS = 24;

export async function matroskaPacketGrid(track: InputAudioTrack): Promise<PacketGrid | null> {
  try {
    if (!((await track.input.getFormat()) instanceof MatroskaInputFormat)) return null;
    const codec = await track.getCodec();
    if (codec !== "aac" && codec !== "mp3") return null;
    const rate = track.sampleRate;
    if (!(rate > 0)) return null;
    const sink = new EncodedPacketSink(track);
    const times: number[] = [];
    let p = await sink.getFirstPacket({ metadataOnly: true });
    while (p && times.length < SAMPLE_PACKETS) {
      times.push(p.timestamp);
      p = await sink.getNextPacket(p, { metadataOnly: true });
    }
    if (times.length < 3) return null;
    const mean = (times[times.length - 1] - times[0]) / (times.length - 1);
    const frame = FRAME_SAMPLES.map((n) => n / rate).find((f) => Math.abs(f - mean) < 0.0006);
    if (!frame) return null;
    // Every stored time within its whole-ms rounding of the grid: a stream of
    // equal frames, as encoders write them.
    for (let k = 1; k < times.length; k++) {
      if (Math.abs(times[k] - (times[0] + k * frame)) > 0.0011) return null;
    }
    return { first: times[0], frame };
  } catch {
    return null;
  }
}

/**
 * How far to move a run whose first chunk is stamped `ts`: onto the grid.
 * `timing` anchors it: with a CodecDelay, ffmpeg stamps the first kept
 * sample at the first packet's whole-ms time plus the whole-ms delay, and the
 * packets are the exact priming (`audioPadding`) before it, not the whole-ms
 * one: 0.33 ms for AAC's 1024 samples at 48 kHz, 0.02 ms for LAME's 1105.
 */
export function gridShift(grid: PacketGrid, ts: number, timing?: { audioCodecDelay: number; audioPadding?: number } | null): number {
  const exactPriming = timing && timing.audioCodecDelay > 0 && (timing.audioPadding ?? 0) > 0 ? timing.audioCodecDelay - timing.audioPadding! : 0;
  const first = grid.first + exactPriming;
  const onGrid = first + Math.round((ts - first) / grid.frame) * grid.frame;
  return Math.abs(onGrid - ts) <= 0.0011 ? onGrid - ts : 0;
}
