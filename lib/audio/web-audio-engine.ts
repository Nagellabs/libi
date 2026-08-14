"use client";

import { Input, UrlSource, ALL_FORMATS, AudioBufferSink } from "mediabunny";
import type { AudioClip } from "@/lib/engine/types";
import { effectiveVolume } from "@/lib/audio/active-clips";
import { applyDuckParams } from "@/lib/audio/web-audio-mixer";
import {
  compToCtxTime,
  clipSourceRange,
  AUDIO_CROSSFADE_S,
} from "@/lib/audio/schedule-math";
import { SCHEDULE_AHEAD_S } from "@/lib/preview/tuning";
import { recordPreviewEvent } from "@/lib/preview/telemetry";
import { audioFadeSeconds } from "@/lib/effects/audio-envelope";

/** Path to the sidechain envelope-follower worklet (shared with the legacy
 *  duck graph). Output is an audio-rate gain signal: 1.0 = no reduction,
 *  dropping toward `reductionMin` while the sidechain is above threshold. */
const SIDECHAIN_WORKLET_URL = "/worklets/sidechain-envelope.js";

interface EngineClip {
  clip: AudioClip;
  url: string;
  ready: Promise<void>;
  sink: AudioBufferSink | null;
  input: Input | null;
  /** Per-clip volume + crossfade envelope. Decoded buffer sources connect
   *  here; this feeds either `duckGain` (when ducked) or the master. */
  gain: GainNode;
  nodes: Set<AudioBufferSourceNode>;
  pumpAbort: AbortController | null;
  /** Ducking (set only while `clip.duck` resolves to a present sidechain):
   *  gain → duckGain → master, with duckGain.gain driven by the worklet. */
  duckGain: GainNode | null;
  duckWorklet: AudioWorkletNode | null;
  /** The sidechain clip's gain node we tapped into the worklet — kept so
   *  teardown can sever exactly that edge and the sig can detect a swap. */
  duckSidechainGain: GainNode | null;
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
 * sidechain envelope-follower worklet, fed from the sidechain clip's gain.
 * When the sidechain is silent the worklet emits ~1.0 (full level); when it
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

  constructor(resolveUrl: (fileId: string) => string, masterVolume = 1) {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = masterVolume;
    this.masterVolume = masterVolume;
    this.master.connect(this.ctx.destination);
    this.resolveUrl = resolveUrl;
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
    void this.reconcileDucks();
  }

  private createClip(clip: AudioClip, url: string): EngineClip {
    const gain = this.ctx.createGain();
    gain.connect(this.master);
    const ec: EngineClip = {
      clip, url, sink: null, input: null, gain,
      nodes: new Set(), pumpAbort: null, ready: Promise.resolve(),
      duckGain: null, duckWorklet: null, duckSidechainGain: null, duckSig: null,
    };
    ec.ready = (async () => {
      const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
      ec.input = input;
      const track = await input.getPrimaryAudioTrack();
      if (track) ec.sink = new AudioBufferSink(track);
    })();
    // A clip destroyed before its audio track resolves (StrictMode unmount,
    // setClips reconcile, engine dispose) disposes ec.input, rejecting this init
    // promise with InputDisposedError. Schedulers await ec.ready inside their own
    // guards; attach a no-op catch so the init promise itself never surfaces as
    // an unhandled rejection (mirrors MediaBunnyFrameSource's constructor guard).
    void ec.ready.catch(() => {});
    return ec;
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
    const range = clipSourceRange(clip, fromComp);
    if (!range) return;

    // Gain envelope: clip volume with a short crossfade ramp at each edge.
    const vol = effectiveVolume(clip, { masterVolume: 1, masterMuted: false });
    const startCtx = compToCtxTime(clip.startTime, this.anchorComp, this.anchorCtx, this.speed);
    const endCtx = compToCtxTime(clip.startTime + clip.duration, this.anchorComp, this.anchorCtx, this.speed);
    const ramp = Math.min(AUDIO_CROSSFADE_S, clip.duration / 2);
    const g = ec.gain.gain;
    const t0 = Math.max(this.ctx.currentTime, startCtx);
    // Compute fade lengths up-front so the crossfade block can defer to them.
    const fade = audioFadeSeconds(clip);
    g.cancelScheduledValues(t0);
    g.setValueAtTime(startCtx <= this.ctx.currentTime ? vol : 0, t0);
    // Skip the opening crossfade ramp when an explicit fade-in owns that boundary.
    if (startCtx > this.ctx.currentTime && !fade.inSec) g.linearRampToValueAtTime(vol, startCtx + ramp);
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
    void (async () => {
      try {
        await ec.ready;
        if (!ec.sink || ac.signal.aborted) return;
        // Telemetry-only: measure the iterator's yield time (decode/await) and the
        // synchronous node-scheduling cost per chunk, to correlate audio-pump
        // bursts with the playback-loop's dropped frames. No behavior change.
        let tPrev = performance.now();
        for await (const wrapped of ec.sink.buffers(range.sourceStart, range.sourceEnd)) {
          const tYield = performance.now();
          if (ac.signal.aborted) return;
          const compTime = clip.startTime + (wrapped.timestamp - clip.trimStart);
          const ctxTime = compToCtxTime(compTime, this.anchorComp, this.anchorCtx, this.speed);
          // Skip chunks already in the past (clamp guards the tiny boundary case).
          if (ctxTime < this.ctx.currentTime - 0.05) { tPrev = performance.now(); continue; }
          const node = this.ctx.createBufferSource();
          node.buffer = wrapped.buffer;
          if (this.speed !== 1) node.playbackRate.value = this.speed;
          node.connect(ec.gain);
          node.start(Math.max(ctxTime, this.ctx.currentTime));
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
        if (!ac.signal.aborted) {
          console.warn("[WebAudioEngine] clip schedule failed", (err as Error)?.message);
        }
      }
    })();
  }

  // ─── Sidechain ducking ──────────────────────────────────────────────

  /** Load the envelope-follower worklet module once for this context. */
  private ensureWorklet(): Promise<void> {
    if (!this.workletReady) {
      this.workletReady = this.ctx.audioWorklet.addModule(SIDECHAIN_WORKLET_URL);
    }
    return this.workletReady;
  }

  /** Stable signature of the duck graph a clip should currently have —
   *  null when it should have none. Reference-compares the sidechain gain
   *  node so a sidechain rebuild (url change) forces a re-tap. */
  private duckSignature(ec: EngineClip): string | null {
    const d = ec.clip.duck;
    if (!d) return null;
    const sidechain = this.clips.get(d.sidechainClipId);
    if (!sidechain || sidechain === ec) return null;
    return `${d.sidechainClipId}|${d.thresholdDb}|${d.ratio}|${d.attackMs}|${d.releaseMs}|${d.reductionDb}`;
  }

  /** Re-evaluate every clip's duck graph; rebuild only those that changed. */
  private async reconcileDucks(): Promise<void> {
    for (const ec of this.clips.values()) {
      await this.rebuildDuck(ec);
    }
  }

  /** Sever this clip's duck graph and restore the direct gain → master route. */
  private teardownDuck(ec: EngineClip): void {
    if (ec.duckSidechainGain && ec.duckWorklet) {
      try { ec.duckSidechainGain.disconnect(ec.duckWorklet); } catch { /* gone */ }
    }
    if (ec.duckWorklet) { try { ec.duckWorklet.disconnect(); } catch { /* gone */ } }
    if (ec.duckGain) {
      try { ec.gain.disconnect(ec.duckGain); } catch { /* gone */ }
      try { ec.duckGain.disconnect(); } catch { /* gone */ }
      try { ec.gain.connect(this.master); } catch { /* already routed */ }
    }
    ec.duckGain = null;
    ec.duckWorklet = null;
    ec.duckSidechainGain = null;
    ec.duckSig = null;
  }

  /** Build/refresh the sidechain duck graph for one clip (idempotent). */
  private async rebuildDuck(ec: EngineClip): Promise<void> {
    const desired = this.duckSignature(ec);
    const sidechain = ec.clip.duck ? this.clips.get(ec.clip.duck.sidechainClipId) : undefined;
    // Fold the sidechain node identity into the comparison so a rebuilt
    // sidechain (new gain node) re-taps even when params are unchanged.
    const same = desired !== null
      && desired === ec.duckSig
      && ec.duckSidechainGain === (sidechain?.gain ?? null);
    if (same) return;

    this.teardownDuck(ec);
    if (desired === null || !sidechain || !ec.clip.duck) return;

    await this.ensureWorklet();
    // The clip set may have changed while the worklet loaded — re-validate.
    if (this.clips.get(ec.clip.id) !== ec) return;
    const sc = this.clips.get(ec.clip.duck.sidechainClipId);
    if (!sc) return;

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
    sc.gain.connect(worklet);

    // Reroute the clip's audio through the duck stage.
    try { ec.gain.disconnect(); } catch { /* */ }
    ec.gain.connect(duckGain);
    duckGain.connect(this.master);

    ec.duckGain = duckGain;
    ec.duckWorklet = worklet;
    ec.duckSidechainGain = sc.gain;
    ec.duckSig = desired;
  }

  dispose(): void {
    this.playing = false;
    for (const ec of this.clips.values()) this.destroyClip(ec);
    this.clips.clear();
    try { this.master.disconnect(); } catch { /* */ }
    void this.ctx.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
