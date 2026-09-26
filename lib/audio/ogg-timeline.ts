import { EncodedPacketSink, OggInputFormat, type EncodedPacket, type InputAudioTrack } from "mediabunny";

/**
 * Where an Ogg stream's decoded audio sits on ffmpeg's timeline.
 *
 * mediabunny (1.60) stamps Ogg packets from two different origins:
 * - Read in order from the stream's first packet, times count from 0 (less
 *   an Opus pre-skip): mediabunny assumes the stream's first granule is 0.
 * - `getPacket(t)` bisects the pages by their granule positions, which are
 *   the real times. When the page it settles on is the stream's first page
 *   (a target before the second page's granule), it then walks from that page
 *   in the first timeline; from the second page on, its times are the
 *   granules'.
 * The two agree only when the stream's granules start at 0. An Ogg cut made
 * with `-ss … -c copy` keeps its source's granules (ffmpeg starts it at −0.3 s),
 * and a stream that starts after its file carries its lead in them: played
 * from the start such a file was right, and after a seek past the second page
 * it was off by that much (an Ogg Opus cut 300 ms early, reviewed 2026-09-26,
 * R3-M4).
 *
 * So the engine asks the server where the stream's first packet is (`/timing`:
 * `startTime` + `oggFirstPacket`, which ffprobe reads from the granules).
 * `seqShift` moves the first timeline onto ffmpeg's. A run whose
 * target lies before the second page's granule time decodes from the first
 * packet, on the first timeline, shifted; any later one seeks, on the
 * granules' timeline, unshifted. With the server's answer missing the shift
 * is 0, as before.
 *
 * The second page's end on the first timeline is found by walking the first
 * two pages: a packet ends on a new page when its `sequenceNumber` (the end
 * page's byte offset plus the segment index) doesn't step by its lacing
 * values (its size / 255 + 1).
 * docs-local/qa/2026-09-25-mediabunny-upgrade-report.md (round 3)
 */
export interface OggTimeline {
  /** mediabunny's timestamp of the stream's first packet. */
  firstPacketTime: number;
  /** Where the stream's second page ends, on mediabunny's first timeline. */
  secondPageEnd: number;
}

/** A packet's lacing values: its size in 255-byte segments, plus the terminator. */
function lacingValues(p: EncodedPacket): number {
  return Math.floor(p.byteLength / 255) + 1;
}

/** Caps the walk on a malformed stream. */
const MAX_WALK_PACKETS = 4096;

/** The track's Ogg timeline facts, or null for a track that isn't in Ogg. */
export async function oggTimeline(track: InputAudioTrack): Promise<OggTimeline | null> {
  try {
    if (!((await track.input.getFormat()) instanceof OggInputFormat)) return null;
    const packets = new EncodedPacketSink(track);
    const first = await packets.getFirstPacket({ metadataOnly: true });
    if (!first) return null;
    let last = first;
    let pagesEnded = 0;
    for (let i = 0; i < MAX_WALK_PACKETS; i++) {
      const next = await packets.getNextPacket(last, { metadataOnly: true });
      if (!next) break;
      if (next.sequenceNumber - last.sequenceNumber !== lacingValues(next) && ++pagesEnded === 2) {
        return { firstPacketTime: first.timestamp, secondPageEnd: next.timestamp };
      }
      last = next;
    }
    // A stream of at most two pages: every target is before the second page's end.
    return { firstPacketTime: first.timestamp, secondPageEnd: last.timestamp + last.duration };
  } catch {
    return null;
  }
}

/**
 * The seconds to add to a first-timeline run's timestamps to put them on
 * ffmpeg's timeline: where the run's first decoded audio really is, minus
 * where mediabunny stamps it. With the server's answer missing, 0.
 * - Opus: the first packet decodes (pre-skip 0), stamped at −pre-skip on the
 *   first timeline (`seqFirstPacket`); really at `startTime + oggFirstPacket`.
 * - Vorbis: the first packet decodes to no audio, and the first audio, stamped
 *   at mediabunny's first-packet time, is really the first packet's end:
 *   `startTime + oggFirstPacket + oggFirstPacketDuration`.
 * `firstPacketSilent` says which.
 */
export function oggSeqShift(
  t: { startTime: number | null; oggFirstPacket: number | null; oggFirstPacketDuration: number },
  seqFirstPacket: number,
  firstPacketSilent: boolean,
): number {
  const { startTime, oggFirstPacket } = t;
  if (startTime === null || oggFirstPacket === null || !Number.isFinite(startTime) || !Number.isFinite(oggFirstPacket)) return 0;
  return startTime + oggFirstPacket + (firstPacketSilent ? t.oggFirstPacketDuration : 0) - seqFirstPacket;
}

export interface OggRunPlan {
  /** Decode from here: a packet's timestamp on the run's own timeline. */
  decodeFrom: number;
  /** Add to every decoded chunk's timestamp (ffmpeg's timeline). */
  shift: number;
  /** The run starts at the stream's first packet (mediabunny's first timeline). */
  fromFirstPacket: boolean;
}

/**
 * How a run that must cover ffmpeg-timeline time `rawTarget` decodes: from
 * the first packet when the target is before the second page's granule time
 * (where mediabunny would answer on its first timeline anyway), else from the
 * packet `getPacket` finds, on the granules' timeline.
 */
export async function planOggRun(
  tl: OggTimeline,
  packets: Pick<EncodedPacketSink, "getPacket">,
  rawTarget: number,
  seqShift: number,
  /**
   * Vorbis: the first packet of a run that starts mid-stream decodes to no
   * audio (it only primes the overlap), yet the run's chunks are stamped from
   * its time, so they are one packet early (21.3 ms for a long block, in
   * Electron 36): moved back by its duration. A run from the stream's start
   * is exact (that packet's duration is 0).
   */
  firstPacketSilent = false,
): Promise<OggRunPlan> {
  const fromStart: OggRunPlan = { decodeFrom: tl.firstPacketTime, shift: seqShift, fromFirstPacket: true };
  if (rawTarget < tl.secondPageEnd + seqShift) return fromStart;
  const packet = await packets.getPacket(rawTarget, { metadataOnly: true });
  if (!packet) return fromStart;
  return { decodeFrom: packet.timestamp, shift: firstPacketSilent ? packet.duration : 0, fromFirstPacket: false };
}
