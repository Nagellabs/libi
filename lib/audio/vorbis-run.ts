import type { EncodedPacketSink } from "mediabunny";

/**
 * Vorbis outside Ogg (WebM, MKV): where a decode run starts, and where its
 * first audio sits on the file's timeline.
 *
 * A Vorbis run's first packet only primes the decoder's overlap and decodes
 * to no audio, yet Chromium stamps the run's chunks from that packet's time:
 * the audio came out one packet early (2.7 ms from the start, 12 to 21.3 ms
 * after a seek, in Electron 36 against ffmpeg 9.0.1). The run's audio starts
 * where the NEXT packet does.
 *
 * Matroska stores packet times in whole ms, so that time is up to 0.5 ms off
 * the sample the audio really starts at (measured ±0.33 ms). Every Vorbis
 * packet starts on a grid of a quarter short block (64 samples, 1.33 ms, for
 * libvorbis at 44.1 / 48 kHz) counted from the track's first audio: its
 * length is a quarter of the two block sizes it overlaps. When that grid is
 * coarser than 1 ms, the rounded time snaps back onto the exact sample. The
 * grid's start is known only for a track that still has its encoder's
 * priming (a Matroska CodecDelay: its first audio is the track's start); a
 * stream-copied cut, whose first packet is wherever the cut fell, keeps the
 * whole-ms time.
 */
export interface VorbisRun {
  /** Where the sink decodes from, on mediabunny's timestamps. */
  decodeFrom: number;
  /** How far after `decodeFrom` the run's first audio starts. */
  shift: number;
}

/**
 * The grid, in seconds, every packet of a Vorbis stream starts on (a quarter
 * of its short block), from the WebCodecs description (the Xiph-laced
 * headers Matroska carries as CodecPrivate). Null when the description can't
 * be read, or the grid is too fine for a whole-ms time to find its sample.
 */
export function vorbisPacketGrid(description: AllowSharedBufferSource | undefined, sampleRate: number): number | null {
  if (!description || !(sampleRate > 0)) return null;
  const d = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description);
  if (d.length < 1 || d[0] !== 2) return null; // three headers
  // Xiph lacing: the first header's size is a run of 255s plus one smaller byte.
  let i = 1;
  while (i < d.length && d[i] === 255) i++;
  i++; // the last lacing byte of header 1
  while (i < d.length && d[i] === 255) i++;
  i++; // … and of header 2
  const id = i; // the identification header follows the lacing
  const isId = d[id] === 1 && String.fromCharCode(...d.subarray(id + 1, id + 7)) === "vorbis";
  if (!isId || id + 28 >= d.length) return null;
  const shortBlock = 1 << (d[id + 28] & 0x0f);
  const grid = shortBlock / 4 / sampleRate;
  return grid > 0.001 ? grid : null;
}

/**
 * The run from the packet at or before `target`. `origin` is where the
 * file's time 0 sits on mediabunny's timestamps; with a `grid` (and the
 * track's first audio at `trackStart` on the file's timeline), the run's
 * audio lands on the grid's exact sample.
 */
export async function vorbisRun(
  packets: EncodedPacketSink,
  target: number,
  origin = 0,
  grid: number | null = null,
  trackStart = 0,
): Promise<VorbisRun | null> {
  const packet =
    (await packets.getPacket(target, { metadataOnly: true })) ?? (await packets.getFirstPacket({ metadataOnly: true }));
  if (!packet) return null;
  const audioAt = packet.timestamp + packet.duration - origin; // on the file's timeline, whole ms
  const exact = grid ? trackStart + Math.round((audioAt - trackStart) / grid) * grid : audioAt;
  return { decodeFrom: packet.timestamp, shift: exact + origin - packet.timestamp };
}
