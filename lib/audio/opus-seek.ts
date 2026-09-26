import { EncodedPacketSink, IsobmffInputFormat, type InputAudioTrack } from "mediabunny";
import { oggTimeline, planOggRun, type OggTimeline } from "@/lib/audio/ogg-timeline";

/**
 * Opus placed where ffmpeg's decode (and so the export) has it, from any start.
 *
 * An Opus stream starts with `pre-skip` samples of encoder priming (312 from
 * libopus: 6.5 ms), declared in the OpusHead that mediabunny hands WebCodecs
 * as the decoder description. Chromium's Opus decoder discards that many
 * samples after EVERY configure, and mediabunny configures a fresh decoder
 * for every run, at the packet a seek or a trimmed start lands on. Measured
 * in Electron 36 against ffmpeg's decode:
 * - Ogg Opus from any packet after the first: 6.5 ms early (real audio
 *   thrown away, the rest labelled with the packet's time).
 * - WebM / MKV Opus after the first packet: 1 ms late. Matroska stores whole
 *   milliseconds shifted by the CodecDelay (ffmpeg writes round(pts) + 7 ms),
 *   so a stored time leads the packet's true start by 7.5 ms, which the 6.5 ms
 *   discard only partly cancels.
 * - MP4 Opus from anywhere, the clip start included: 6.5 ms early. Its edit
 *   list already hides the priming, and the decoder skipped it again.
 *
 * So libi never lets the decoder skip anything, and places the audio itself:
 * - every run decodes with pre-skip 0 in its OpusHead (`noPreSkipTrack`);
 * - a run past the first packet starts `SEEK_PREROLL_S` early, on a whole
 *   packet (Opus's recommended 80 ms pre-roll: the decoder converges on it),
 *   and the engine drops what ends before the requested start;
 * - every chunk moves by its packet's lead: stored time minus true start.
 *   - MP4/MOV: 0. mediabunny applies the edit list, so its times are
 *     presentation times; a stream-copied cut lists pre-roll packets before
 *     0, which the engine drops like any pre-roll.
 *   - Matroska: the track's first packet starts `pre-skip` before the
 *     track's first decoded sample, which is `audioLead` after the file's
 *     start (the origin): 0 for a file ffmpeg wrote, 0.343 s for a browser
 *     recording whose video starts first (review round 3, R3-C1: taking the
 *     first packet to start at the origin put that voice 343 ms early). A
 *     track without a CodecDelay (`skipsPreSkip` false) still has its
 *     pre-skip skipped by ffmpeg's decoder, which then stamps the first kept
 *     sample at the first packet's time plus the pre-skip in whole ms (7 ms
 *     for 312 samples): its first packet starts there less the pre-skip
 *     (it was 7 ms early, then 0.5 ms, review round 4). The
 *     second packet starts one first-packet later (its exact sample count,
 *     from its TOC byte). The first packet's lead and the lead every later
 *     packet shares (constant for a stream of equal frames, as encoders
 *     write) follow: 6.5 ms, then 7.5 ms for ffmpeg's WebM.
 *   - Ogg: a run from the stream's first packet is on mediabunny's first-page
 *     timeline, where that packet starts `pre-skip` before 0 (and is stamped
 *     0: a 6.5 ms lead); `ogg-timeline.ts` moves the run onto ffmpeg's. A run
 *     that seeks past the first page has the granules' exact times: lead 0.
 * The priming before the track's first sample then sits before it, where the
 * engine never plays anything.
 * docs-local/qa/2026-09-25-mediabunny-upgrade-report.md
 */

/** Opus's recommended decoder pre-roll after a seek (RFC 7845 §4.6). */
export const SEEK_PREROLL_S = 0.08;

const OPUS_RATE = 48000;

/** The OpusHead's pre-skip, in samples at 48 kHz; null when it isn't one. */
export function opusPreSkip(description: AllowSharedBufferSource | undefined): number | null {
  const b = toBytes(description);
  if (!b || b.length < 12 || String.fromCharCode(...b.subarray(0, 8)) !== "OpusHead") return null;
  return b[10] | (b[11] << 8);
}

/** The decoder config with pre-skip 0 in its OpusHead (the description is copied). */
export function withoutPreSkip(config: AudioDecoderConfig): AudioDecoderConfig {
  const b = toBytes(config.description);
  if (!b || opusPreSkip(b) === null) return config;
  const copy = b.slice();
  copy[10] = 0;
  copy[11] = 0;
  return { ...config, description: copy };
}

/** Samples at 48 kHz in one Opus packet, from its TOC byte (RFC 6716 §3.1); null if malformed. */
export function opusPacketSamples(data: Uint8Array): number | null {
  if (data.length < 1) return null;
  const toc = data[0];
  const config = toc >> 3;
  let frameMs: number;
  if (config < 12) frameMs = [10, 20, 40, 60][config & 3];
  else if (config < 16) frameMs = [10, 20][config & 1];
  else frameMs = [2.5, 5, 10, 20][config & 3];
  const code = toc & 3;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code < 3) frames = 2;
  else {
    if (data.length < 2) return null;
    frames = data[1] & 0x3f;
  }
  return (frames * frameMs * OPUS_RATE) / 1000;
}

export interface OpusSeekInfo {
  preSkip: number;
  /** mediabunny timestamp of the stream's first packet. */
  firstPacketTime: number;
  /** Its exact length in samples (TOC); null when unreadable. */
  firstPacketSamples: number | null;
  /** mediabunny timestamp of the second packet; null for a one-packet stream. */
  secondPacketTime: number | null;
  /** MP4/MOV: mediabunny's times are presentation times (edit list applied). */
  presentationTimes: boolean;
  /** Ogg: where mediabunny's two timelines meet (ogg-timeline.ts); null elsewhere. */
  ogg: OggTimeline | null;
  /** A view of the track whose decoder config carries pre-skip 0. */
  noPreSkipTrack: InputAudioTrack;
}

/**
 * What placing an Opus track needs, or null for any other codec (or when it
 * can't be worked out, which leaves the track on mediabunny's stock path).
 */
export async function opusSeekInfo(track: InputAudioTrack): Promise<OpusSeekInfo | null> {
  try {
    if ((await track.getCodec()) !== "opus") return null;
    const config = await track.getDecoderConfig();
    const preSkip = opusPreSkip(config?.description);
    if (preSkip === null) return null;
    const packets = new EncodedPacketSink(track);
    const first = await packets.getFirstPacket();
    if (!first) return null;
    const second = await packets.getNextPacket(first, { metadataOnly: true });
    const presentationTimes = (await track.input.getFormat()) instanceof IsobmffInputFormat;
    const ogg = await oggTimeline(track);
    // A view of the same track: mediabunny's sinks read the config through
    // getDecoderConfig() when they create a decoder; everything else is the
    // track's own.
    const noPreSkipTrack = Object.create(track) as InputAudioTrack;
    noPreSkipTrack.getDecoderConfig = async () => {
      const c = await track.getDecoderConfig();
      return c ? withoutPreSkip(c) : c;
    };
    return {
      preSkip,
      firstPacketTime: first.timestamp,
      firstPacketSamples: opusPacketSamples(first.data),
      secondPacketTime: second?.timestamp ?? null,
      presentationTimes,
      ogg,
      noPreSkipTrack,
    };
  } catch {
    return null;
  }
}

/** Where a file's audio sits: see `OpusPlacement` in the engine. */
export interface OpusPlacement {
  /** Raw time of the file's source time 0 (ffmpeg's `format.start_time`). */
  origin: number;
  /** Seconds after the file's start the track's first decoded sample is. */
  audioLead: number;
  /** Ogg: shift of mediabunny's first-page timeline onto ffmpeg's (ogg-timeline.ts). */
  seqShift: number;
  /**
   * Matroska: ffmpeg skips the pre-skip only when the track declares it as its
   * CodecDelay (it sends the decoder skip samples from that). A WebM without
   * CodecDelay decodes its priming as audio in ffmpeg, from the first
   * packet's time: false then. Default true (the server hasn't said).
   */
  skipsPreSkip?: boolean;
  /**
   * Matroska: the packets ffmpeg cuts short by a DiscardPadding, as
   * `[seconds after the stream's first packet, samples]` (the timing route's
   * `opusTrims`). Absent: none known.
   */
  trims?: ReadonlyArray<readonly [number, number]>;
}

/**
 * Stored time minus true start, for the first packet and for every later one
 * (Matroska and any other container without presentation times).
 */
export function opusLeads(
  info: OpusSeekInfo,
  place: Pick<OpusPlacement, "origin" | "audioLead" | "skipsPreSkip">,
): { first: number; later: number } {
  if (info.presentationTimes) return { first: 0, later: 0 };
  const firstTrueStart = firstPacketTrueStart(info, place);
  const first = info.firstPacketTime - firstTrueStart;
  if (info.secondPacketTime === null || info.firstPacketSamples === null) return { first, later: first };
  return { first, later: info.secondPacketTime - (firstTrueStart + info.firstPacketSamples / OPUS_RATE) };
}

export interface OpusRunPlan {
  /** Decode from here: a packet's stored time. */
  decodeFrom: number;
  /** Add to every decoded chunk's timestamp: it is then on ffmpeg's timeline. */
  shift: number;
  /**
   * The packets ffmpeg cuts short at or after `decodeFrom` (Matroska joins
   * and end trims, `OpusPlacement.trims`), on the run's shifted timeline. The
   * engine trims each one's chunk the same way, and moves every later chunk
   * up by what it cut (`trimChunk`).
   */
  trims: OpusTrim[];
  /**
   * Raw time of the track's first sample ffmpeg plays: the pre-skip before
   * it is encoder priming, which ffmpeg drops and the decode here (pre-skip
   * 0) doesn't. The engine plays nothing of the track before it. null: no
   * priming left to drop (an MP4 edit list already hid it, Ogg).
   */
  audibleFrom: number | null;
}

/** A packet ffmpeg cuts short, on ffmpeg's timeline (raw: origin included). */
export interface OpusTrim {
  /** Where the packet's audio truly starts. */
  at: number;
  /** Seconds ffmpeg drops from its end. */
  discard: number;
}

/**
 * A stretch of a Matroska Opus stream between two joins: its packets start
 * on a grid of `frame` seconds from `trueStart`, and are stored `lead` after
 * their true start (give or take the container's whole ms).
 */
interface OpusSegment {
  /** Stored time of its first packet (−∞ for the stream's first stretch). */
  storedFrom: number;
  trueStart: number;
  /** Its packets' length (TOC); null when unknown, and nothing snaps. */
  frame: number | null;
  lead: number;
}

interface OpusLayout {
  segments: OpusSegment[];
  trims: Array<OpusTrim & { stored: number }>;
}

type PacketReader = Pick<EncodedPacketSink, "getPacket"> & Partial<Pick<EncodedPacketSink, "getNextPacket">>;

/** A packet's samples from its TOC, reading its bytes when the lookup gave none; null when unknown. */
async function packetSamples(packets: PacketReader, p: { timestamp: number; data?: Uint8Array }): Promise<number | null> {
  if (p.data && p.data.length > 0) return opusPacketSamples(p.data);
  const full = await packets.getPacket(p.timestamp).catch(() => null);
  return full?.data && full.data.length > 0 ? opusPacketSamples(full.data) : null;
}

const layouts = new WeakMap<OpusSeekInfo, { key: string; layout: Promise<OpusLayout> }>();

/**
 * The stream's stretches and trimmed packets (Matroska). Without trims, one
 * stretch from the first packet, as before. Each trim starts a new stretch at
 * the packet after it: ffmpeg plays that packet right after the trimmed
 * one's kept samples, so its true start is exact, and its own frame length
 * (TOC) sets the new grid (review round 4: a join of 60 ms and 20 ms frame
 * encodes played 53.5 ms late after the join, and was snapped onto the wrong
 * grid).
 */
function opusLayout(info: OpusSeekInfo, packets: PacketReader, place: OpusPlacement): Promise<OpusLayout> {
  const key = JSON.stringify([place.origin, place.audioLead, place.skipsPreSkip, place.trims ?? []]);
  const hit = layouts.get(info);
  if (hit && hit.key === key) return hit.layout;
  const layout = (async (): Promise<OpusLayout> => {
    const firstTrueStart = firstPacketTrueStart(info, place);
    const first: OpusSegment = {
      storedFrom: -Infinity,
      trueStart: firstTrueStart,
      frame: info.firstPacketSamples !== null ? info.firstPacketSamples / OPUS_RATE : null,
      lead: opusLeads(info, place).later,
    };
    const out: OpusLayout = { segments: [first], trims: [] };
    for (const [after, discard] of place.trims ?? []) {
      const stored = info.firstPacketTime + after;
      const p = await packets.getPacket(stored + 0.0001).catch(() => null);
      if (!p || Math.abs(p.timestamp - stored) > 0.0006) continue; // not a packet mediabunny lists
      const samples = await packetSamples(packets, p);
      if (samples === null || discard >= samples) continue;
      const seg = segmentAt(out.segments, p.timestamp);
      const at = trueStartOf(seg, p.timestamp, samples);
      out.trims.push({ stored: p.timestamp, at, discard: discard / OPUS_RATE });
      const next = packets.getNextPacket ? await packets.getNextPacket(p).catch(() => null) : null;
      if (!next) continue;
      const nextSamples = await packetSamples(packets, next);
      const trueStart = at + (samples - discard) / OPUS_RATE;
      out.segments.push({
        storedFrom: next.timestamp,
        trueStart,
        frame: nextSamples !== null ? nextSamples / OPUS_RATE : null,
        lead: next.timestamp - trueStart,
      });
    }
    return out;
  })();
  layouts.set(info, { key, layout });
  return layout;
}

function segmentAt(segments: OpusSegment[], stored: number): OpusSegment {
  let seg = segments[0];
  for (const s of segments) if (s.storedFrom <= stored + 1e-9) seg = s;
  return seg;
}

/** A jitter this small is a recorder's timestamp noise, not a different frame. */
const MAX_SNAP_S = 0.005;

/**
 * The true start of the packet stored at `stored`, with its stored time's
 * jitter taken out. A browser recording (MediaRecorder) stamps its 60 ms Opus
 * frames 58, 60 or 62 ms apart, up to 3 ms off the samples they hold, while
 * ffmpeg's decode (and so the export) plays the samples back to back: a run
 * placed by its first packet's stored time was up to 3 ms off (review round
 * 3). The packet's true start is on its stretch's grid of whole frames, so
 * the nearest grid point is it, when it is within `MAX_SNAP_S` of the
 * constant lead's guess, and the packet is one of the stretch's frames: a
 * packet of another length (a file whose encoder changed frame size) is off
 * that grid, and keeps the guess (review round 4). `samples` null: its
 * length is unknown, and it is taken to be one.
 */
function trueStartOf(seg: OpusSegment, stored: number, samples: number | null): number {
  const guess = stored - seg.lead;
  const frame = seg.frame;
  if (!frame || (samples !== null && Math.abs(samples / OPUS_RATE - frame) > 1e-9)) return guess;
  const onGrid = seg.trueStart + Math.round((guess - seg.trueStart) / frame) * frame;
  return Math.abs(onGrid - guess) <= MAX_SNAP_S ? onGrid : guess;
}

/** How a run that should start at raw time `from` decodes. */
export async function planOpusRun(
  info: OpusSeekInfo,
  packets: PacketReader,
  from: number,
  place: OpusPlacement,
): Promise<OpusRunPlan> {
  const target = from - SEEK_PREROLL_S;
  if (info.ogg) {
    const run = await planOggRun(info.ogg, packets, target, place.seqShift);
    // From the first packet: stamped 0 (mediabunny clamps), truly `pre-skip`
    // before 0 on that timeline. Later pages: granule-exact.
    const lead = run.fromFirstPacket ? info.firstPacketTime + info.preSkip / OPUS_RATE : 0;
    return { decodeFrom: run.decodeFrom, shift: run.shift - lead, trims: [], audibleFrom: null };
  }
  if (info.presentationTimes) {
    // MP4: presentation times, but a browser recording's are jittered like
    // its WebM's (mr-av.mp4 was 2.7 ms off): the same snap, on the grid of
    // whole frames (review round 3), anchored where ffmpeg has them
    // (`mp4Anchor`).
    const anchor = await mp4Anchor(info, packets);
    const fromFirst = { decodeFrom: info.firstPacketTime, shift: anchor.gridStart - info.firstPacketTime, trims: [], audibleFrom: anchor.audibleFrom };
    const packet = target > info.firstPacketTime ? await packets.getPacket(target, { metadataOnly: true }) : null;
    if (!packet || packet.timestamp <= info.firstPacketTime) return fromFirst;
    const seg: OpusSegment = {
      storedFrom: -Infinity,
      trueStart: anchor.gridStart,
      frame: info.firstPacketSamples !== null ? info.firstPacketSamples / OPUS_RATE : null,
      lead: 0,
    };
    const at = trueStartOf(seg, packet.timestamp, await packetSamples(packets, packet));
    return { decodeFrom: packet.timestamp, shift: at - packet.timestamp, trims: [], audibleFrom: anchor.audibleFrom };
  }
  const leads = opusLeads(info, place);
  const layout = await opusLayout(info, packets, place);
  const trimsFrom = (decodeFrom: number) => layout.trims.filter((t) => t.stored >= decodeFrom - 1e-9).map(({ at, discard }) => ({ at, discard }));
  // The pre-skip is priming ffmpeg never plays.
  const audibleFrom = info.preSkip > 0 ? firstPacketTrueStart(info, place) + info.preSkip / OPUS_RATE : null;
  const atFirst = { decodeFrom: info.firstPacketTime, shift: -leads.first, trims: trimsFrom(info.firstPacketTime), audibleFrom };
  if (target <= info.firstPacketTime) return atFirst;
  const packet = await packets.getPacket(target, { metadataOnly: true });
  if (!packet || packet.timestamp <= info.firstPacketTime) return atFirst;
  const seg = segmentAt(layout.segments, packet.timestamp);
  const trimmed = layout.trims.find((t) => Math.abs(t.stored - packet.timestamp) < 1e-9);
  const at = trimmed ? trimmed.at : trueStartOf(seg, packet.timestamp, await packetSamples(packets, packet));
  return { decodeFrom: packet.timestamp, shift: at - packet.timestamp, trims: trimsFrom(packet.timestamp), audibleFrom };
}

const mp4Anchors = new WeakMap<OpusSeekInfo, Promise<{ gridStart: number; audibleFrom: number | null }>>();

/**
 * Where an MP4 Opus track's packets truly start, and its first audible
 * sample. With an edit list over the priming (ffmpeg's own MP4s: the first
 * packet stamped before 0), mediabunny's times are ffmpeg's: the grid starts
 * at the first packet, nothing is left to drop. Without one (a Chrome
 * MediaRecorder MP4: pre-skip 3840, the first packet at 0), ffmpeg skips the
 * pre-skip itself and stamps the first sample it keeps at ITS packet's time
 * plus what it skipped of it: the packets are back to back from there
 * (mr-av.mp4: 2879 + 960 samples, where the first packet's grid said 2880;
 * the 80 ms before it are silent in ffmpeg, and played here: review round 4).
 */
function mp4Anchor(info: OpusSeekInfo, packets: PacketReader): Promise<{ gridStart: number; audibleFrom: number | null }> {
  const hit = mp4Anchors.get(info);
  if (hit) return hit;
  const anchor = (async () => {
    const plain = { gridStart: info.firstPacketTime, audibleFrom: null };
    if (info.preSkip <= 0 || info.firstPacketTime < -1e-9 || !packets.getNextPacket) return plain;
    let p = await packets.getPacket(info.firstPacketTime).catch(() => null);
    let before = 0;
    for (let i = 0; p && i < 64; i++) {
      const n = await packetSamples(packets, p);
      if (n === null) return plain;
      if (before + n > info.preSkip) {
        const gridStart = p.timestamp - before / OPUS_RATE;
        return { gridStart, audibleFrom: gridStart + info.preSkip / OPUS_RATE };
      }
      before += n;
      p = await packets.getNextPacket(p).catch(() => null);
    }
    return plain;
  })();
  mp4Anchors.set(info, anchor);
  return anchor;
}

/**
 * A decoded chunk against the run's trims: `ts` is its start on the run's
 * shifted timeline, after earlier trims' moves. When it is a trimmed
 * packet's, the seconds to cut from its end (0 otherwise); `trims` is
 * consumed as the run passes them.
 */
export function trimChunk(trims: OpusTrim[], ts: number): number {
  while (trims.length > 0 && trims[0].at < ts - 0.001) trims.shift(); // passed without a chunk of its own
  if (trims.length > 0 && Math.abs(trims[0].at - ts) <= 0.001) return trims.shift()!.discard;
  return 0;
}

/** Where the track's first packet truly starts, priming included (Matroska and alike). */
function firstPacketTrueStart(info: OpusSeekInfo, place: Pick<OpusPlacement, "origin" | "audioLead" | "skipsPreSkip">): number {
  const preSkip = info.preSkip / OPUS_RATE;
  // No CodecDelay: ffmpeg stamps the first kept sample the pre-skip after the
  // packet, rounded to Matroska's whole ms (av_rescale_q, halves away from 0).
  const skipped = place.skipsPreSkip === false ? preSkip - Math.round(info.preSkip / 48) / 1000 : preSkip;
  return place.origin + Math.max(0, place.audioLead) - skipped;
}

function toBytes(d: AllowSharedBufferSource | undefined): Uint8Array | null {
  if (!d) return null;
  if (d instanceof Uint8Array) return d;
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return new Uint8Array(d as ArrayBuffer);
}
