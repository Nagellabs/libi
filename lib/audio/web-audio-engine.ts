"use client";

import { Input, UrlSource, ALL_FORMATS, AudioBufferSink, EncodedPacketSink } from "mediabunny";
import { opusSeekInfo, planOpusRun, trimChunk, SEEK_PREROLL_S, type OpusPlacement, type OpusSeekInfo, type OpusTrim } from "@/lib/audio/opus-seek";
import { oggSeqShift, oggTimeline, planOggRun, type OggTimeline } from "@/lib/audio/ogg-timeline";
import { mediaFetchRetryDelay } from "@/lib/engine/media-fetch-retry";
import type { AudioClip } from "@/lib/engine/types";
import { effectiveVolume } from "@/lib/audio/active-clips";
import { applyDuckParams } from "@/lib/audio/web-audio-mixer";
import { duckSidechainIds } from "@/lib/audio/duck-params";
import {
  compToCtxTime,
  clipSourceRange,
  AUDIO_CROSSFADE_S,
} from "@/lib/audio/schedule-math";
import { SCHEDULE_AHEAD_S } from "@/lib/preview/tuning";
import { recordPreviewEvent } from "@/lib/preview/telemetry";
import { audioFadeSeconds } from "@/lib/effects/audio-envelope";
import {
  classifyMediaLoadError,
  httpStatusOf,
  mediaErrorMessage,
  UnplayableMediaError,
} from "@/lib/engine/media-load-failure";
import { repairHeAacTrack } from "@/lib/audio/he-aac-track";
import { vorbisPacketGrid, vorbisRun } from "@/lib/audio/vorbis-run";
import { gridShift, matroskaPacketGrid, type PacketGrid } from "@/lib/audio/packet-grid";
import { primaryAudioTrack } from "@/lib/engine/primary-track";
import { attributeMediaLogs } from "@/lib/engine/sps-diagnostics";
import {
  audioTimelineShift,
  fallbackOrigin,
  ifSettled,
  originFromTiming,
  retryServerTiming,
  serverTiming,
  type ServerTiming,
} from "@/lib/engine/source-time-origin";

/** Path to the sidechain envelope-follower worklet (shared with the legacy
 *  duck graph). Output is an audio-rate gain signal: 1.0 = no reduction,
 *  dropping toward `reductionMin` while the sidechain is above threshold. */
const SIDECHAIN_WORKLET_URL = "/worklets/sidechain-envelope.js";

/** A clip whose audio can't be played in the preview from any source. */
export interface UnplayableAudioClip {
  clipId: string;
  fileId: string;
  label?: string;
  /**
   * Why the ORIGINAL can't be played:
   * - `undecodable`: it loaded, but its audio can't be decoded here.
   * - `unavailable`: the file itself couldn't be loaded (an HTTP 4xx, e.g.
   *   missing).
   * The proxy stand-in failing too is what makes it unplayable either way.
   */
  cause: "undecodable" | "unavailable";
  /** The last error, for logs. */
  detail: string;
}

/** Whether a file has, or will have, a proxy to fall back to. "unknown":
 *  the owner can't tell (a file it has no row for). */
export type ProxyState = "none" | "pending" | "ready" | "unknown";

/** A ProxyState plus the proxy's revision (e.g. its generation time), so a
 *  proxy regenerated while its status stayed "ready" reads as new. */
export interface ProxyStatus {
  state: ProxyState;
  revision?: string | number | null;
}

export interface WebAudioEngineOptions {
  /** Called once per clip when neither its original nor its fallback can be
   *  played, so the preview can tell the user in-app rather than only in the
   *  console. Not called when the fallback saves the clip. */
  onUnplayable?: (info: UnplayableAudioClip) => void;
  /**
   * Whether `fileId` has a proxy right now. It is read at the moment a
   * fallback is needed, and again on each later play or seek.
   * - "none": the file can never have one (audio-only, VPx alpha). The proxy
   *   is never requested.
   * - "pending": one is expected but not ready. It is requested once it lands.
   * - "ready": it exists. With a `revision`, a new revision counts as a new
   *   proxy (final review F1).
   * - "unknown": the owner has no row for the file. It is tried once per play
   *   or seek, the round-2 behaviour (final review F2).
   * Omitted: a fallback URL means "ready".
   */
  proxyState?: (fileId: string) => ProxyState | ProxyStatus;
}

interface EngineClip {
  clip: AudioClip;
  /** The clip's primary source (the original). Reconcile compares on this. */
  url: string;
  /** Where the audio comes from if the original can't be decoded here (the
   *  proxy, whose track is AAC-LC). null = no fallback. */
  fallbackUrl: string | null;
  /** Which source `sink` reads. */
  source: "primary" | "fallback";
  /**
   * The original's audio misreads here without failing, so the proxy's is
   * played as soon as it is ready: a chained Ogg plays its first stream and
   * then silence, FLAC in Ogg lists no track (the server's
   * `preferProxyAudio`, or no listed track). Review round 4.
   */
  wantsProxy: boolean;
  /** Neither source can be played right now. Scheduling skips the clip
   *  (unless `retryFallback`), and it reports only once (`reported`). */
  failed: boolean;
  /**
   * The proxy's state when this clip last had no playable source, or "never"
   * after a proxy failed to decode. A failed clip opens the proxy again only
   * when its state has since become "ready" (it landed, or was regenerated),
   * never on every play or seek (Review M1, Re-review R4).
   */
  proxySeen: ProxyStatus | "never" | null;
  /** onUnplayable / the "can't be played" line have fired for this clip. */
  reported: boolean;
  /** Why the original failed, once it has. */
  primaryCause: UnplayableAudioClip["cause"] | null;
  ready: Promise<void>;
  sink: AudioBufferSink | null;
  /** Opus only: how to place each run (opus-seek.ts); `sink` then decodes
   *  with pre-skip 0. null for every other codec. */
  opus: { info: OpusSeekInfo; packets: EncodedPacketSink } | null;
  /** Ogg, any other codec: where mediabunny's two Ogg timelines meet
   *  (ogg-timeline.ts), and a packet sink to plan runs with. */
  ogg: { timeline: OggTimeline; packets: EncodedPacketSink } | null;
  /** Vorbis outside Ogg (WebM, MKV): packets to plan runs with, and the
   *  grid its packets start on (vorbis-run.ts). */
  vorbis: { packets: EncodedPacketSink; grid: number | null } | null;
  /** AAC or MP3 in Matroska: the grid of whole frames its runs snap to (packet-grid.ts). */
  grid: PacketGrid | null;
  /** The server's word on that grid's anchor (its CodecDelay, whole-ms and exact). */
  gridTiming: { audioCodecDelay: number; audioPadding?: number } | null;
  input: Input | null;
  /** Raw timestamp of this source's time 0 (sourceTimeOrigin). The original
   *  and its ffmpeg-rebased proxy then line up. */
  origin: number;
  /** The track's first decoded sample, seconds after the file's start
   *  (placing an Opus track that starts late, opus-seek.ts). */
  audioLead: number;
  /** Ogg: shift of a first-page run onto ffmpeg's timeline (ogg-timeline.ts). */
  seqShift: number;
  /** Opus in Matroska: ffmpeg skips the pre-skip (the track declares a CodecDelay). */
  skipsPreSkip: boolean;
  /** Opus in Matroska: the packets ffmpeg cuts short (timing `opusTrims`, opus-seek.ts). */
  opusTrims: ReadonlyArray<readonly [number, number]>;
  /** mediabunny's own origin, used until (or unless) the server answers. */
  fallback: number;
  codec: string | null;
  /** The server answered this source's timing lookup. Until it does, play
   *  and seek ask again (retryServerTiming). */
  timingAnswered: boolean;
  /** Per-clip volume + crossfade envelope. Decoded buffer sources connect
   *  here; this feeds either `duckGain` (when ducked) or the master. */
  gain: GainNode;
  nodes: Set<AudioBufferSourceNode>;
  pumpAbort: AbortController | null;
  /** Ducking (set only while `clip.duck` resolves to a present sidechain):
   *  gain → duckGain → master, with duckGain.gain driven by the worklet. */
  duckGain: GainNode | null;
  duckWorklet: AudioWorkletNode | null;
  /** The sidechain clips' gain nodes we tapped into the worklet, in order —
   *  kept so teardown can sever exactly those edges and the sig can detect a
   *  swap. All of them feed the worklet's ONE input; Web Audio sums fan-in,
   *  which is the duck we want (it responds to whichever voice is speaking). */
  duckSidechainGains: GainNode[];
  /** Signature of the duck graph currently built, so reconcile rebuilds
   *  only on a real change (params or sidechain node identity). */
  duckSig: string | null;
}

/**
 * Audio-master playback engine. One shared `AudioContext` is the master clock;
 * `getCompositionTime()` is derived from `ctx.currentTime` against the play
 * anchor, and the same anchor is used to schedule each clip's decoded audio
 * chunks (from mediabunny `AudioBufferSink`) on the context timeline — so audio
 * and the time the video chases are, by construction, the same clock (no drift).
 *
 * Sidechain ducking: a clip with `clip.duck` is routed gain → duckGain →
 * master, where duckGain.gain (intrinsic 0) is driven entirely by the shared
 * sidechain envelope-follower worklet, fed from the sidechain clips' gains —
 * ALL of them, into the worklet's single input, which Web Audio sums. When the
 * sidechains are silent the worklet emits ~1.0 (full level); when their sum
 * exceeds threshold the music dips toward reductionMin. The duck graph is
 * reconciled in `setClips` and is independent of buffer scheduling.
 */
export class WebAudioEngine {
  readonly ctx: AudioContext;
  private master: GainNode;
  private clips = new Map<string, EngineClip>();
  private anchorComp = 0;
  private anchorCtx = 0;
  private speed = 1;
  private playing = false;
  private masterVolume = 1;
  private resolveUrl: (fileId: string) => string;
  /** Memoized worklet-module load (once per context). */
  private workletReady: Promise<void> | null = null;
  /** Set by dispose() BEFORE the context closes, so in-flight async work
   *  (worklet load, duck rebuild) can tell a teardown race from a real
   *  failure — same contract as `pumpAbort` on the clip scheduler. */
  private disposed = false;

  private resolveFallbackUrl: (fileId: string) => string | null;

  /**
   * @param resolveUrl the clip's source: the ORIGINAL file, for fidelity.
   * @param resolveFallbackUrl the source to use if the original's audio can't
   *   be decoded in this browser: the proxy, which carries an AAC-LC transcode.
   *   A 404 there (an audio file, or a video whose proxy isn't ready) just
   *   means the clip can't be played.
   */
  constructor(
    resolveUrl: (fileId: string) => string,
    masterVolume = 1,
    resolveFallbackUrl: (fileId: string) => string | null = () => null,
    private readonly options: WebAudioEngineOptions = {},
  ) {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = masterVolume;
    this.masterVolume = masterVolume;
    this.master.connect(this.ctx.destination);
    this.resolveUrl = resolveUrl;
    this.resolveFallbackUrl = resolveFallbackUrl;
  }

  /** Master clock read by the transport (composition seconds). */
  getCompositionTime(): number {
    if (!this.playing) return this.anchorComp;
    return this.anchorComp + (this.ctx.currentTime - this.anchorCtx) * this.speed;
  }

  /** Reconcile the live clip set: create players for new clips, drop removed
   *  ones, rebuild on url change. Does not start audio (that's play/seek). */
  setClips(clips: AudioClip[]): void {
    const seen = new Set<string>();
    for (const clip of clips) {
      seen.add(clip.id);
      const url = this.resolveUrl(clip.fileId);
      const existing = this.clips.get(clip.id);
      if (existing && existing.url === url) {
        existing.clip = clip; // refresh volume/timing
        continue;
      }
      if (existing) this.destroyClip(existing);
      this.clips.set(clip.id, this.createClip(clip, url));
    }
    for (const [id, ec] of this.clips) {
      if (!seen.has(id)) { this.destroyClip(ec); this.clips.delete(id); }
    }
    if (this.playing) this.rescheduleAll();
    // Duck graphs depend on the now-reconciled clip set (sidechain must
    // exist before we can tap it). Fire-and-forget — rebuildDuck no-ops when
    // unchanged and guards against clips that mutate while the worklet loads.
    void this.reconcileDucks().catch((err) => {
      // rebuildDuck already absorbs teardown races; anything reaching here is
      // unexpected and worth surfacing.
      if (!this.disposed) {
        console.warn("[WebAudioEngine] duck reconcile failed", (err as Error)?.message);
      }
    });
  }

  private createClip(clip: AudioClip, url: string): EngineClip {
    const gain = this.ctx.createGain();
    // Silent until scheduleClip sets the envelope. The intrinsic 1 would
    // otherwise play a chunk scheduled ahead of the clip's start at full level
    // (Re-review R5).
    gain.gain.value = 0;
    gain.connect(this.master);
    const fallbackUrl = this.resolveFallbackUrl(clip.fileId);
    const ec: EngineClip = {
      clip, url, fallbackUrl: fallbackUrl && fallbackUrl !== url ? fallbackUrl : null,
      source: "primary", wantsProxy: false, failed: false, proxySeen: null, reported: false, primaryCause: null,
      sink: null, opus: null, ogg: null, vorbis: null, grid: null, gridTiming: null, input: null, origin: 0, audioLead: 0, seqShift: 0, skipsPreSkip: true, opusTrims: [], fallback: 0, codec: null,
      timingAnswered: false, gain,
      nodes: new Set(), pumpAbort: null, ready: Promise.resolve(),
      duckGain: null, duckWorklet: null, duckSidechainGains: [], duckSig: null,
    };
    this.openSource(ec, url);
    return ec;
  }

  /** Point the clip at `url`: a fresh Input, and a sink over its audio track. */
  private openSource(ec: EngineClip, url: string): void {
    ec.opus = null;
    ec.ogg = null;
    ec.vorbis = null;
    ec.grid = null;
    ec.gridTiming = null;
    ec.timingAnswered = false;
    ec.ready = (async () => {
      const input = new Input({
        // Bounded retries: mediabunny's default retries a same-origin fetch
        // failure forever. See media-fetch-retry.ts.
        source: new UrlSource(url, { getRetryDelay: mediaFetchRetryDelay }),
        formats: ALL_FORMATS,
      });
      ec.input = input;
      // The server's timing is asked for at once and never waited on: until
      // it lands the clip plays on mediabunny's own origin (review I1).
      const timing = serverTiming(url);
      // Reading the first timestamp lists the tracks, and in MPEG-TS listing
      // them parses the video's HEVC SPS: both run inside the attribution
      // region (sps-diagnostics.ts), so a bad SPS is said once, naming the file.
      const { fallback, track } = await attributeMediaLogs(url, async () => ({
        fallback: await fallbackOrigin(input),
        track: await primaryAudioTrack(input),
      }));
      if (!track) {
        // An original with no audio track mediabunny lists, while ffmpeg may
        // still see one (a Matroska track mediabunny drops: disabled or
        // compressed; FLAC in Ogg). The proxy carries the server's pick as
        // AAC, so try it once, or as soon as it lands. A proxy without audio
        // either is a silent file: not a failure.
        if (ec.source === "primary" && ec.fallbackUrl) {
          ec.wantsProxy = true;
          if (canTryProxy(this.proxyStatusOf(ec).state)) throw new NoListedAudioTrackError(url);
        }
        return;
      }
      // HE-AAC's decoder config needs repairing or WebCodecs refuses it (the
      // Dreams clip, he-aac-track.ts).
      repairHeAacTrack(track);
      if (!(await track.canDecode())) {
        throw new UnplayableMediaError(`the audio of ${url} can't be decoded here`);
      }
      ec.codec = await track.getCodec();
      ec.fallback = fallback;
      const opus = await opusSeekInfo(track);
      ec.opus = opus ? { info: opus, packets: new EncodedPacketSink(track) } : null;
      const ogg = opus ? null : await oggTimeline(track);
      ec.ogg = ogg ? { timeline: ogg, packets: new EncodedPacketSink(track) } : null;
      if (!ogg && ec.codec === "vorbis") {
        const config = await track.getDecoderConfig().catch(() => null);
        ec.vorbis = { packets: new EncodedPacketSink(track), grid: config ? vorbisPacketGrid(config.description, config.sampleRate) : null };
      }
      if (!opus && !ogg && !ec.vorbis) ec.grid = await matroskaPacketGrid(track);
      ec.sink = new AudioBufferSink(opus ? opus.noPreSkipTrack : track);
      // Where the file's source time 0 and this track sit on mediabunny's
      // timestamps (placementFor). Usually the server's answer is already
      // here; otherwise the clip plays on the fallback and takes the answer
      // when it lands, however late.
      const early = await ifSettled(timing, NOT_YET);
      if (early !== NOT_YET && early && this.prefersProxy(ec, early)) throw new ProxyPreferredError(url);
      this.setPlacement(ec, early === NOT_YET ? null : early);
      if (early === NOT_YET) void timing.then((t) => this.applyTiming(ec, input, t));
    })();
    // A clip destroyed before its audio track resolves (StrictMode unmount,
    // setClips reconcile, engine dispose) disposes ec.input, rejecting this init
    // promise with InputDisposedError. Schedulers await ec.ready inside their own
    // guards; attach a no-op catch so the init promise itself never surfaces as
    // an unhandled rejection (mirrors MediaBunnyFrameSource's constructor guard).
    void ec.ready.catch(() => {});
  }

  /**
   * Where source time 0 and the track sit, from the server's answer `t` (null:
   * none yet, mediabunny's own origin).
   * - Ogg with an answer: the file's start unclamped (a cut starts before 0),
   *   and first-page runs moved onto ffmpeg's timeline (ogg-timeline.ts).
   * - Otherwise the file's start plus this track's timeline shift against
   *   ffmpeg's (a Matroska CodecDelay), and the track's lead for Opus: the
   *   server's `audioStart`, or before it answers the first packet's distance
   *   from the origin (both 0.343 s on a browser recording, R3-C1).
   */
  private placementFor(ec: EngineClip, t: ServerTiming | null): OpusPlacement {
    const isOgg = !!(ec.opus?.info.ogg ?? ec.ogg);
    if (isOgg && t && t.startTime !== null) {
      // Where mediabunny puts the first packet read in order: −pre-skip for
      // Opus (it stamps that packet 0, opus-seek.ts takes the difference), its
      // own time for anything else.
      const seqFirst = ec.opus ? -ec.opus.info.preSkip / 48000 : ec.ogg?.timeline.firstPacketTime ?? 0;
      return { origin: t.startTime, audioLead: 0, seqShift: oggSeqShift(t, seqFirst, ec.codec === "vorbis") };
    }
    const origin = (originFromTiming(t) ?? ec.fallback) + audioTimelineShift(ec.codec, t);
    const audioLead = t
      ? Math.max(0, t.audioStart ?? 0)
      : ec.opus ? Math.max(0, ec.opus.info.firstPacketTime - origin) : 0;
    // ffmpeg skips an Opus pre-skip only when a Matroska track declares it as
    // its CodecDelay (opus-seek.ts `skipsPreSkip`).
    return { origin, audioLead, seqShift: 0, skipsPreSkip: t ? t.audioCodecDelay > 0 : true, trims: t?.opusTrims ?? [] };
  }

  /** Take a placement; true when it moved anything. */
  private setPlacement(ec: EngineClip, t: ServerTiming | null): boolean {
    if (t) ec.timingAnswered = true;
    const p = this.placementFor(ec, t);
    const skips = p.skipsPreSkip !== false;
    // Only what places this clip's audio counts: a late answer that changes
    // a field its codec and container never read reschedules nothing (review
    // round 4: a browser recording, pre-skip 0, flipped `skipsPreSkip` and
    // took a 3-5 ms dropout for no move). Differences under 2 samples at
    // 48 kHz are the server's and mediabunny's roundings of one time.
    const EPS = 4e-5;
    const opusMatroska = !!ec.opus && !ec.opus.info.presentationTimes && !ec.opus.info.ogg;
    const isOgg = !!(ec.opus?.info.ogg ?? ec.ogg);
    const moved =
      Math.abs(p.origin - ec.origin) > EPS ||
      (opusMatroska && Math.abs(p.audioLead - ec.audioLead) > EPS) ||
      (isOgg && Math.abs(p.seqShift - ec.seqShift) > EPS) ||
      (opusMatroska && ec.opus!.info.preSkip > 0 && skips !== ec.skipsPreSkip) ||
      (opusMatroska && JSON.stringify(p.trims ?? []) !== JSON.stringify(ec.opusTrims)) ||
      // Vorbis in Matroska snaps to a grid from its track start, when it keeps its priming.
      (!!ec.vorbis?.grid && (Math.abs(p.audioLead - ec.audioLead) > EPS || skips !== ec.skipsPreSkip));
    // The AAC / MP3 grid's anchor moves by under 0.5 ms: taken from the next
    // run on, never worth rescheduling a playing clip for (a dropout).
    if (t) ec.gridTiming = { audioCodecDelay: t.audioCodecDelay, audioPadding: t.audioPadding };
    ec.origin = p.origin;
    ec.audioLead = p.audioLead;
    ec.seqShift = p.seqShift;
    ec.opusTrims = p.trims ?? [];
    ec.skipsPreSkip = skips;
    return moved;
  }

  /**
   * The server's timing landed after the clip started on its fallback: take
   * it, and if the clip is playing and anything moved, reschedule it from now.
   */
  private applyTiming(ec: EngineClip, input: Input, t: ServerTiming | null): void {
    if (this.disposed || ec.input !== input || !t) return;
    if (this.prefersProxy(ec, t)) {
      this.switchToProxy(ec);
      return;
    }
    if (!this.setPlacement(ec, t)) return;
    if (this.playing && ec.pumpAbort && !ec.pumpAbort.signal.aborted) {
      ec.pumpAbort.abort();
      this.stopNodes(ec);
      this.scheduleClip(ec, this.getCompositionTime());
    }
  }

  /**
   * On play and seek: ask the server again for every source whose lookup
   * failed, once its back-off has passed (retryServerTiming bounds the
   * attempts). Never waited on: the clip keeps playing on its fallback.
   */
  private retryTimings(): void {
    for (const ec of this.clips.values()) {
      const input = ec.input;
      if (!input || ec.timingAnswered) continue;
      const again = retryServerTiming(ec.source === "primary" ? ec.url : ec.fallbackUrl ?? ec.url);
      if (again) void again.then((t) => this.applyTiming(ec, input, t));
    }
  }

  /**
   * The server says the original's audio misreads here without failing
   * (`preferProxyAudio`): remember it, and true when the proxy can be read
   * now. Until it can, the original plays (a chained Ogg's first stream is
   * still right); `scheduleClip` switches once the proxy is ready.
   */
  private prefersProxy(ec: EngineClip, t: ServerTiming): boolean {
    if (ec.source !== "primary" || !ec.fallbackUrl || !t.preferProxyAudio) return false;
    ec.wantsProxy = true;
    return canTryProxy(this.proxyStatusOf(ec).state);
  }

  /** Read the proxy from now on, rescheduling a clip that is playing. */
  private switchToProxy(ec: EngineClip): void {
    if (!ec.fallbackUrl) return;
    console.warn(`[WebAudioEngine] ${ec.clip.id}: the original's audio doesn't read right here; playing the proxy's audio instead`);
    ec.pumpAbort?.abort();
    this.stopNodes(ec);
    ec.input?.dispose();
    ec.input = null;
    ec.sink = null;
    ec.failed = false;
    ec.source = "fallback";
    this.openSource(ec, ec.fallbackUrl);
    if (this.playing) this.scheduleClip(ec, this.getCompositionTime());
  }

  /**
   * A source of `ec` failed while a pump was reading it. Returns true when the
   * clip now has (or already had) a different source to read, so the pump
   * should reschedule. Returns false when there is nothing to switch to; the
   * caller logs a transient failure, and a permanent one marks the clip dead.
   *
   * Only a decode-side or permanent failure moves to the fallback. A network
   * flake keeps the original: the next play or seek retries it.
   */
  private switchAfterFailure(ec: EngineClip, failedReady: Promise<void>, err: unknown): boolean {
    if (ec.ready !== failedReady) return true; // another pump already switched
    const permanent =
      classifyMediaLoadError(err) === "permanent" ||
      (err as { name?: unknown } | null)?.name === "OperationError";
    if (!permanent) return false;
    const why = mediaErrorMessage(err);
    const status = httpStatusOf(err);
    if (ec.source === "primary") {
      ec.primaryCause = status !== null ? "unavailable" : "undecodable";
    }
    if (ec.source === "primary" && ec.fallbackUrl && canTryProxy(this.proxyStatusOf(ec).state)) {
      console.warn(
        `[WebAudioEngine] ${ec.clip.id}: the original's audio can't be ${
          ec.primaryCause === "unavailable" ? "loaded" : "decoded here"
        } (${why}); playing the proxy's audio instead`,
      );
      ec.input?.dispose();
      ec.input = null;
      ec.sink = null;
      ec.source = "fallback";
      this.openSource(ec, ec.fallbackUrl);
      return true;
    }
    ec.failed = true;
    // Remember the proxy's state. A proxy that was expected but not ready, or
    // that 404'd, is tried again once its state turns "ready". A proxy that
    // loaded but can't be decoded never is.
    ec.proxySeen = ec.source === "fallback" && status !== 404 ? "never" : this.proxyStatusOf(ec);
    if (ec.reported) return false;
    ec.reported = true;
    console.warn(`[WebAudioEngine] ${ec.clip.id}: audio can't be played (${why})`);
    try {
      this.options.onUnplayable?.({
        clipId: ec.clip.id,
        fileId: ec.clip.fileId,
        ...(ec.clip.label ? { label: ec.clip.label } : {}),
        cause: ec.primaryCause ?? "undecodable",
        detail: why,
      });
    } catch {
      /* an owner's notice must never break playback */
    }
    return false;
  }

  private proxyStatusOf(ec: EngineClip): ProxyStatus {
    if (!ec.fallbackUrl) return { state: "none" };
    try {
      const answer = this.options.proxyState?.(ec.clip.fileId) ?? "ready";
      return typeof answer === "string" ? { state: answer } : answer;
    } catch {
      return { state: "none" };
    }
  }

  /**
   * Whether a failed clip should open its proxy now:
   * - it has since turned "ready" (it landed);
   * - it is "ready" with a new revision (regenerated while the status stayed
   *   "ready": final review F1);
   * - its state is "unknown" (no row to watch), in which case it is tried
   *   once per play or seek (F2).
   */
  private proxyNowAvailable(ec: EngineClip): boolean {
    if (ec.proxySeen === "never" || !ec.fallbackUrl) return false;
    const seen = ec.proxySeen;
    const now = this.proxyStatusOf(ec);
    ec.proxySeen = now;
    if (now.state === "unknown") return true;
    if (now.state !== "ready") return false;
    return !seen || seen.state !== "ready" || (seen.revision ?? null) !== (now.revision ?? null);
  }

  private destroyClip(ec: EngineClip): void {
    ec.pumpAbort?.abort();
    this.stopNodes(ec);
    this.teardownDuck(ec);
    try { ec.gain.disconnect(); } catch { /* already gone */ }
    ec.input?.dispose();
    ec.input = null;
    ec.sink = null;
  }

  private stopNodes(ec: EngineClip): void {
    for (const n of ec.nodes) { try { n.stop(); n.disconnect(); } catch { /* not started */ } }
    ec.nodes.clear();
  }

  play(): void {
    if (this.playing) return;
    void this.ctx.resume();
    this.anchorCtx = this.ctx.currentTime;
    this.playing = true;
    this.retryTimings();
    this.rescheduleAll();
  }

  pause(): void {
    if (!this.playing) return;
    this.anchorComp = this.getCompositionTime();
    this.playing = false;
    for (const ec of this.clips.values()) { ec.pumpAbort?.abort(); this.stopNodes(ec); }
  }

  seek(compTime: number): void {
    this.anchorComp = compTime;
    this.anchorCtx = this.ctx.currentTime;
    this.retryTimings();
    if (this.playing) this.rescheduleAll();
  }

  setSpeed(speed: number): void {
    this.anchorComp = this.getCompositionTime();
    this.anchorCtx = this.ctx.currentTime;
    this.speed = speed;
    if (this.playing) this.rescheduleAll();
  }

  setMasterVolume(v: number): void {
    this.masterVolume = Math.max(0, Math.min(1, v));
    this.master.gain.value = this.masterVolume;
  }

  private rescheduleAll(): void {
    const now = this.getCompositionTime();
    for (const ec of this.clips.values()) {
      ec.pumpAbort?.abort();
      this.stopNodes(ec);
      this.scheduleClip(ec, now);
    }
  }

  /** Schedule clip gain envelope + a decode-ahead pump of audio chunks. */
  private scheduleClip(ec: EngineClip, fromComp: number): void {
    const { clip } = ec;
    if (!clip.enabled) return;
    if (ec.wantsProxy && ec.source === "primary" && !ec.failed && ec.fallbackUrl && this.proxyStatusOf(ec).state === "ready") {
      // The original misreads here, and the proxy has landed since: play it.
      ec.pumpAbort?.abort();
      this.stopNodes(ec);
      ec.input?.dispose();
      ec.input = null;
      ec.sink = null;
      ec.source = "fallback";
      this.openSource(ec, ec.fallbackUrl);
    }
    if (ec.failed) {
      if (!this.proxyNowAvailable(ec)) return;
      // The proxy landed since the clip failed: play it.
      ec.failed = false;
      ec.input?.dispose();
      ec.input = null;
      ec.sink = null;
      ec.source = "fallback";
      this.openSource(ec, ec.fallbackUrl!);
    }
    const range = clipSourceRange(clip, fromComp);
    if (!range) return;

    // Gain envelope: clip volume with a short crossfade ramp at each edge.
    const vol = effectiveVolume(clip, { masterVolume: 1, masterMuted: false });
    const startCtx = compToCtxTime(clip.startTime, this.anchorComp, this.anchorCtx, this.speed);
    const endCtx = compToCtxTime(clip.startTime + clip.duration, this.anchorComp, this.anchorCtx, this.speed);
    const ramp = Math.min(AUDIO_CROSSFADE_S, clip.duration / 2);
    const g = ec.gain.gain;
    const nowCtx = this.ctx.currentTime;
    const t0 = Math.max(nowCtx, startCtx);
    // Compute fade lengths up-front so the crossfade block can defer to them.
    const fade = audioFadeSeconds(clip);
    // From NOW: the clip's volume if it is already playing, else 0 until it
    // starts. Scheduling from t0 left the span before it at whatever the gain
    // was, which is the GainNode's intrinsic 1 on a first schedule
    // (Re-review R5).
    g.cancelScheduledValues(nowCtx);
    g.setValueAtTime(startCtx <= nowCtx ? vol : 0, nowCtx);
    if (startCtx > nowCtx) g.setValueAtTime(0, startCtx);
    // Skip the opening crossfade ramp when an explicit fade-in owns that boundary.
    if (startCtx > nowCtx && !fade.inSec) g.linearRampToValueAtTime(vol, startCtx + ramp);
    // Skip the closing crossfade ramp when an explicit fade-out owns that boundary.
    if (!fade.outSec) {
      g.setValueAtTime(vol, Math.max(t0, endCtx - ramp));
      g.linearRampToValueAtTime(0, endCtx);
    }

    // Audio-fade envelope (gated — a clip with no audio-fade effects produces
    // byte-identical scheduling to the crossfade-only path above).
    if (fade.inSec > 0) {
      g.setValueAtTime(0, startCtx);
      g.linearRampToValueAtTime(vol, startCtx + fade.inSec);
    }
    if (fade.outSec > 0) {
      const outStartCtx = endCtx - fade.outSec;
      g.setValueAtTime(vol, Math.max(t0, outStartCtx));
      g.linearRampToValueAtTime(0, endCtx);
    }

    const ac = new AbortController();
    ec.pumpAbort = ac;
    const ready = ec.ready;
    void (async () => {
      try {
        await ready;
        if (!ec.sink || ac.signal.aborted) return;
        // Telemetry-only: measure the iterator's yield time (decode/await) and the
        // synchronous node-scheduling cost per chunk, to correlate audio-pump
        // bursts with the playback-loop's dropped frames. No behavior change.
        let tPrev = performance.now();
        const origin = ec.origin;
        // Decoding may start on an encoder-priming packet (negative timestamp):
        // mediabunny (since 1.45) restores the timestamp Chromium's decoder
        // drops, so the run stays exact. Measured on the Dreams original in
        // Electron 36 with mediabunny 1.60: 0 ms from seek 0 (1.40 was 21.8 ms
        // late, which libi used to work around by skipping those packets).
        const from = range.sourceStart + origin;
        let decodeFrom = from;
        let shift = 0;
        // Opus in Matroska: packets ffmpeg cuts short (a join of two encodes).
        let trims: OpusTrim[] = [];
        // Opus: nothing of the track plays before ffmpeg's first kept sample (its priming).
        let audibleFrom: number | null = null;
        // Opus: decoded with pre-skip 0, from a whole packet with an 80 ms
        // pre-roll, and each chunk moved by its packet's stored-time lead
        // (opus-seek.ts). The pre-roll and the priming end before `from`.
        if (ec.opus) {
          const plan = await planOpusRun(ec.opus.info, ec.opus.packets, from, {
            origin, audioLead: ec.audioLead, seqShift: ec.seqShift, skipsPreSkip: ec.skipsPreSkip, trims: ec.opusTrims,
          });
          if (ac.signal.aborted) return;
          decodeFrom = plan.decodeFrom;
          shift = plan.shift;
          trims = plan.trims.slice();
          audibleFrom = plan.audibleFrom;
        } else if (ec.ogg) {
          // Ogg: a run on the first page counts from mediabunny's own 0, a
          // later one from the granules (ogg-timeline.ts). Same pre-roll as Opus.
          const plan = await planOggRun(ec.ogg.timeline, ec.ogg.packets, from - SEEK_PREROLL_S, ec.seqShift, ec.codec === "vorbis");
          if (ac.signal.aborted) return;
          decodeFrom = plan.decodeFrom;
          shift = plan.shift;
        } else if (ec.vorbis) {
          // Vorbis in WebM / MKV: its first packet decodes to no audio, yet
          // stamps the run; the run's audio snaps to its packet grid when the
          // track keeps its priming (a CodecDelay: vorbis-run.ts).
          const grid = ec.skipsPreSkip ? ec.vorbis.grid : null;
          const plan = await vorbisRun(ec.vorbis.packets, from - SEEK_PREROLL_S, origin, grid, ec.audioLead);
          if (ac.signal.aborted) return;
          if (plan) {
            decodeFrom = plan.decodeFrom;
            shift = plan.shift;
          }
        }
        // The sink counts on the run's own timeline: its end moves with the
        // run, and past what the run's trims cut.
        const trimmed = trims.reduce((sum, t) => sum + t.discard, 0);
        // What the trims so far moved every later chunk by (≤ 0).
        let moved = 0;
        let firstChunk = true;
        for await (const wrapped of ec.sink.buffers(decodeFrom, range.sourceEnd + origin - shift + trimmed)) {
          const tYield = performance.now();
          if (ac.signal.aborted) return;
          // A packet ffmpeg cuts short: WebCodecs decodes all of it and stamps
          // everything after as if nothing was cut (opus-seek.ts). Cut the same
          // samples, and move the rest up by them.
          // AAC / MP3 in Matroska: the run's first chunk carries its packet's
          // whole-ms time; the run moves onto the frame grid (packet-grid.ts).
          if (ec.grid && firstChunk) shift += gridShift(ec.grid, wrapped.timestamp, ec.gridTiming);
          firstChunk = false;
          let timestamp = wrapped.timestamp + shift + moved;
          let buffer = wrapped.buffer;
          let duration = wrapped.duration;
          const tail = trims.length > 0 ? trimChunk(trims, timestamp) : 0;
          if (tail > 0) {
            buffer = this.framesOf(buffer, 0, Math.round((duration - tail) * buffer.sampleRate));
            duration = buffer.duration;
            moved -= tail;
          }
          if (audibleFrom !== null && timestamp < audibleFrom - 1e-7) {
            // The track's priming: its place stays empty, as in ffmpeg.
            if (timestamp + duration <= audibleFrom + 1e-7) continue;
            const skip = Math.round((audibleFrom - timestamp) * buffer.sampleRate);
            buffer = this.framesOf(buffer, skip, buffer.length);
            timestamp += skip / buffer.sampleRate;
            duration = buffer.duration;
          }
          if (timestamp + duration <= from) continue; // pre-roll
          const compTime = clip.startTime + (timestamp - origin - clip.trimStart);
          const ctxTime = compToCtxTime(compTime, this.anchorComp, this.anchorCtx, this.speed);
          // A chunk that ends before now is skipped. One that began before now
          // (the playhead landed inside it on a seek or play start) plays from
          // where the playhead is inside it. Starting it "now" from its
          // beginning put the audio up to a whole chunk late against the
          // picture: 46 ms per HE-AAC frame, far more for a big PCM chunk,
          // which the old 50 ms cut-off dropped entirely instead.
          //
          // Nor does anything play before the clip's own start: the chunk that
          // straddles the trim point begins before it, and its head is audio
          // the user trimmed off (Re-review R5).
          const playFrom = Math.max(this.ctx.currentTime, startCtx);
          if (ctxTime + duration / this.speed <= playFrom) { tPrev = performance.now(); continue; }
          const node = this.ctx.createBufferSource();
          node.buffer = buffer;
          if (this.speed !== 1) node.playbackRate.value = this.speed;
          node.connect(ec.gain);
          node.start(Math.max(ctxTime, playFrom), ctxTime < playFrom ? (playFrom - ctxTime) * this.speed : 0);
          ec.nodes.add(node);
          node.onended = () => { ec.nodes.delete(node); try { node.disconnect(); } catch { /* */ } };
          recordPreviewEvent({
            t: tYield,
            type: "audio",
            src: clip.id,
            yieldMs: +(tYield - tPrev).toFixed(2),
            schedMs: +(performance.now() - tYield).toFixed(2),
          });
          // Throttle: stay ~SCHEDULE_AHEAD_S ahead of the clock.
          while (!ac.signal.aborted && ctxTime > this.ctx.currentTime + SCHEDULE_AHEAD_S) {
            await sleep(50);
          }
          tPrev = performance.now();
        }
      } catch (err) {
        // destroyClip aborts the pump BEFORE disposing the Input, so a dispose
        // race lands here with ac.signal.aborted already true → swallow quietly.
        // (await ec.ready or the buffers() iterator rejecting with
        // InputDisposedError.) Anything else is a real failure worth surfacing.
        if (ac.signal.aborted) return;
        if (this.switchAfterFailure(ec, ready, err)) {
          // Nothing was scheduled from the failed source (the decoder fails
          // before its first chunk), so read the new one from where the clock is.
          if (this.playing && ec.pumpAbort === ac) {
            this.stopNodes(ec);
            this.scheduleClip(ec, this.getCompositionTime());
          }
          return;
        }
        if (!ec.failed) {
          console.warn("[WebAudioEngine] clip schedule failed", mediaErrorMessage(err));
        }
      }
    })();
  }

  /** Frames `from` to `to` of `buffer`, as a new buffer (at least one frame). */
  private framesOf(buffer: AudioBuffer, from: number, to: number): AudioBuffer {
    const start = Math.max(0, Math.min(buffer.length - 1, from));
    const end = Math.max(start + 1, Math.min(buffer.length, to));
    if (start === 0 && end === buffer.length) return buffer;
    const out = this.ctx.createBuffer(buffer.numberOfChannels, end - start, buffer.sampleRate);
    for (let c = 0; c < buffer.numberOfChannels; c++) out.copyToChannel(buffer.getChannelData(c).subarray(start, end), c);
    return out;
  }

  // ─── Sidechain ducking ──────────────────────────────────────────────

  /** Load the envelope-follower worklet module once for this context. */
  private ensureWorklet(): Promise<void> {
    if (!this.workletReady) {
      const load = this.ctx.audioWorklet.addModule(SIDECHAIN_WORKLET_URL);
      this.workletReady = load;
      // A failed load must not disable ducking for the life of the engine:
      // drop the memo so a later reconcile retries. This handler only resets
      // state — the rejection is still delivered to `load`'s awaiters.
      load.catch(() => {
        if (this.workletReady === load) this.workletReady = null;
      });
    }
    return this.workletReady;
  }

  /** The live sidechain clips driving this clip's duck, in declared order.
   *  Ids that name a missing clip (or the clip itself) are skipped, so a duck
   *  with five of six VO lines still present keeps ducking under those five. */
  private duckSources(ec: EngineClip): EngineClip[] {
    if (!ec.clip.duck) return [];
    const out: EngineClip[] = [];
    for (const id of duckSidechainIds(ec.clip.duck)) {
      const sc = this.clips.get(id);
      if (sc && sc !== ec) out.push(sc);
    }
    return out;
  }

  /** Stable signature of the duck graph a clip should currently have —
   *  null when it should have none. The sidechain gain nodes are compared by
   *  reference separately, so a sidechain rebuild (url change) forces a
   *  re-tap even when the ids are unchanged. */
  private duckSignature(ec: EngineClip, sources: EngineClip[]): string | null {
    const d = ec.clip.duck;
    if (!d || sources.length === 0) return null;
    const ids = sources.map((s) => s.clip.id).join(",");
    return `${ids}|${d.thresholdDb}|${d.ratio}|${d.attackMs}|${d.releaseMs}|${d.reductionDb}`;
  }

  /** Re-evaluate every clip's duck graph; rebuild only those that changed. */
  private async reconcileDucks(): Promise<void> {
    for (const ec of this.clips.values()) {
      await this.rebuildDuck(ec);
    }
  }

  /** Sever this clip's duck graph and restore the direct gain → master route. */
  private teardownDuck(ec: EngineClip): void {
    if (ec.duckWorklet) {
      for (const g of ec.duckSidechainGains) {
        try { g.disconnect(ec.duckWorklet); } catch { /* gone */ }
      }
    }
    if (ec.duckWorklet) { try { ec.duckWorklet.disconnect(); } catch { /* gone */ } }
    if (ec.duckGain) {
      try { ec.gain.disconnect(ec.duckGain); } catch { /* gone */ }
      try { ec.duckGain.disconnect(); } catch { /* gone */ }
      try { ec.gain.connect(this.master); } catch { /* already routed */ }
    }
    ec.duckGain = null;
    ec.duckWorklet = null;
    ec.duckSidechainGains = [];
    ec.duckSig = null;
  }

  /** Build/refresh the sidechain duck graph for one clip (idempotent). */
  private async rebuildDuck(ec: EngineClip): Promise<void> {
    const sources = this.duckSources(ec);
    const desired = this.duckSignature(ec, sources);
    // Fold the sidechain node identities into the comparison so a rebuilt
    // sidechain (new gain node) re-taps even when params are unchanged.
    const same = desired !== null
      && desired === ec.duckSig
      && ec.duckSidechainGains.length === sources.length
      && sources.every((s, i) => ec.duckSidechainGains[i] === s.gain);
    if (same) return;

    this.teardownDuck(ec);
    if (desired === null || !ec.clip.duck) return;

    try {
      await this.ensureWorklet();
    } catch (err) {
      // dispose() closes the context, which rejects an in-flight addModule with
      // `AbortError: Unable to load a worklet's module`. That is a teardown
      // race, not a fault — swallow it. Anything else is a real failure (the
      // module 404s, or fails to parse) and leaves this clip un-ducked.
      if (!this.disposed) {
        console.warn("[WebAudioEngine] worklet load failed", (err as Error)?.message);
      }
      return;
    }
    // Disposed while the module loaded: the context is closed and every node
    // constructor below would throw InvalidStateError.
    if (this.disposed) return;
    // The clip set may have changed while the worklet loaded — re-validate.
    if (this.clips.get(ec.clip.id) !== ec) return;
    const live = this.duckSources(ec);
    if (live.length === 0) return;

    const duckGain = this.ctx.createGain();
    // Intrinsic 0: the worklet output is the SOLE driver (1.0 idle → reductionMin
    // ducked). Avoids the additive baseline that would otherwise double the level.
    duckGain.gain.value = 0;
    const worklet = new AudioWorkletNode(this.ctx, "sidechain-envelope", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    applyDuckParams(worklet, ec.clip.duck, this.ctx.sampleRate);
    worklet.connect(duckGain.gain);
    // Every sidechain feeds the worklet's ONE input — Web Audio sums fan-in, so
    // the follower sees the same summed signal the export builds by adding the
    // placed clips into one buffer. The tap stays POST-volume (`.gain`): a
    // pre-volume tap would duck against a level the listener never hears.
    for (const sc of live) sc.gain.connect(worklet);

    // Reroute the clip's audio through the duck stage.
    try { ec.gain.disconnect(); } catch { /* */ }
    ec.gain.connect(duckGain);
    duckGain.connect(this.master);

    ec.duckGain = duckGain;
    ec.duckWorklet = worklet;
    ec.duckSidechainGains = live.map((s) => s.gain);
    // Recomputed from `live`, not `desired`: the clip set may have changed
    // while the worklet module loaded, and the sig must describe what was
    // actually wired or the next reconcile would skip a needed rebuild.
    ec.duckSig = this.duckSignature(ec, live);
  }

  dispose(): void {
    this.disposed = true;
    this.playing = false;
    for (const ec of this.clips.values()) this.destroyClip(ec);
    this.clips.clear();
    try { this.master.disconnect(); } catch { /* */ }
    void this.ctx.close();
  }
}

const NOT_YET = Symbol("not yet");

/** The original has no audio track the preview's demuxer lists. */
/** The server says the original's audio misreads here: the proxy is read instead. */
class ProxyPreferredError extends UnplayableMediaError {
  constructor(url: string) {
    super(`${url}'s audio doesn't read right in the preview`);
    this.name = "ProxyPreferredError";
  }
}

class NoListedAudioTrackError extends UnplayableMediaError {
  constructor(url: string) {
    super(`${url} has no audio track the preview can read`);
    this.name = "NoListedAudioTrackError";
  }
}

/** States in which the proxy may exist: requested at once. */
function canTryProxy(state: ProxyState): boolean {
  return state === "ready" || state === "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
