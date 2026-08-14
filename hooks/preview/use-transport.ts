"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { recordPreviewEvent } from "@/lib/preview/telemetry";
import type { ReadyDecision } from "@/lib/preview/ready-state";
import {
  createFrameStore,
  createSeekSignalStore,
  type FrameStore,
  type SeekSignalStore,
} from "@/lib/preview/frame-store";

/**
 * Seconds of look-ahead the preview's preroll controller uses to warm the
 * upcoming scene before a cut (the original Tier-0 just-in-time prime
 * trigger). Exposed here (rather than buried in the preroll hook) so the
 * transport is the single source of truth for the window and other consumers
 * can reference the same value.
 */
export const PREROLL_LOOKAHEAD_SECONDS = 0.75;

/**
 * Rolling read-ahead target (seconds). The source budget in
 * `use-video-sources` begins warming an UPCOMING source once the playhead is
 * within this many seconds of its boundary, so its first frame is decoded
 * before the cut reaches it — wider than the 0.75 s just-in-time prime so
 * boundary swaps don't cold-decode mid-playback. ~1.5 s comfortably covers a
 * byte-range seek + a few frames of decode on a scrub-friendly proxy while
 * staying well inside a reasonable RAM footprint.
 */
export const LOOKAHEAD_SECONDS = 1.5;

/**
 * Phase-2 playback readiness gate constants.
 *
 * START_MARGIN — legacy full-runway margin (seconds). Retained for reference /
 *   tests; the live gate now releases on START_MARGIN_DROP (below) against the
 *   DOMINANT source, not the worst source.
 *
 * START_MARGIN_DROP — the drop-frames release margin (seconds). The gate releases
 *   as soon as (a) NO active source would paint black (all-can-paint) AND (b) the
 *   DOMINANT (most-visible) source has this much runway — deliberately tiny so a
 *   heavy jump-then-play starts choppy-but-moving (the pro-editor feel) instead of
 *   spinner-buffering until all 12 parallel videos reach full runway. Secondary
 *   sources never gate the clock; they hold-last / drop frames.
 *
 * MAX_GATE_MS — hard safety cap. If the margin isn't met within this long, the
 *   gate releases to `playing` ANYWAY (play possibly-soft rather than hang the
 *   UI forever). The gate must NEVER be able to block playback indefinitely.
 *
 * REBUFFER_THRESHOLD — while already `playing`, the minimum runway below which
 *   a SUSTAINED dip (held for `REBUFFER_GRACE_MS`) re-enters `buffering`. A
 *   momentary 1-frame dip stays in `playing` (the renderer's hold-last-frame
 *   covers it) so the spinner can't flap on micro-underruns.
 *
 * REBUFFER_GRACE_MS — how long the runway must stay below REBUFFER_THRESHOLD
 *   before re-buffering kicks in.
 *
 * GATE_POLL_MS — how often the gate re-checks readiness while `buffering`
 *   (timer-driven, convergent; never a render loop).
 */
export const START_MARGIN = 0.5;
export const START_MARGIN_DROP = 0.2;
export const MAX_GATE_MS = 1500;
export const REBUFFER_THRESHOLD = 0.15;
export const REBUFFER_GRACE_MS = 350;
export const GATE_POLL_MS = 80;

/**
 * Phase-2 video-pacing clamp constants.
 *
 * PACE_LEAD_S — how far (seconds) the wall-clock playhead may lead the active
 *   video's REAL decode position before the tick stops advancing and waits for
 *   the pixels. Kept under the controller's 0.45s steady-playback drift
 *   tolerance so the renderer's drift-seek never fires mid-cold-warmup: the
 *   counter paces to the decoder instead of running ahead and forcing a seek.
 *   A small positive lead (not 0) leaves headroom for normal sub-frame jitter so
 *   the clamp doesn't bind during healthy realtime playback.
 *
 * MAX_PACE_HOLD_MS — safety latch. If the video stays behind for longer than
 *   this (a genuinely stuck/blocked element, e.g. autoplay denied), the clamp
 *   gives up and lets the wall-clock advance anyway — play possibly-soft rather
 *   than freeze the counter forever. The readiness gate / drift-seek recover.
 *   Mirrors the gate's MAX_GATE_MS no-hang philosophy.
 */
export const PACE_LEAD_S = 0.15;
export const MAX_PACE_HOLD_MS = 1200;

/** Transport phase state machine: idle → (buffering →) playing. Press-play
 *  resolves the readiness gate AT EVENT TIME: warm goes straight to playing,
 *  cold enters buffering and the polling effect releases it. */
export type TransportPhase = "idle" | "buffering" | "playing";

/**
 * Probe the drop-frames readiness decision at composition-second `t`: whether
 * every active source can paint (no black) and the DOMINANT source's decoded
 * runway. The editor wires this in (it owns the sources + priorities); the
 * transport stays pure of source ownership. `dominantRunway === Infinity` means
 * nothing gates (e.g. a pure canvas-scene comp). See `computeReadyState`.
 */
export type ReadyAheadProbe = (t: number) => ReadyDecision;

/**
 * Probe wired in by the editor: the active video source's REAL decode position
 * in COMPOSITION seconds at the current playhead `frameNow` — the active
 * scene's source mapped through its scene offset + trim. Returns `null` when
 * nothing should pace the clock (canvas scene, no source, unreadable time) —
 * the transport then advances by pure wall-clock. See the video-pacing clamp.
 */
export type ActiveVideoTimeProbe = (frameNow: number) => number | null;

/**
 * Audio-master control wired in by the editor under the WebCodecs engine. When
 * present, the transport derives `frame` from `getTime()` (the AudioContext
 * clock) and delegates play/pause/seek/speed to it — audio is the master clock,
 * video chases. Absent ⇒ the legacy wall-clock rAF advance + readiness gate.
 */
export interface AudioMasterControl {
  /** Current composition time in seconds (from the audio clock). */
  getTime(): number;
  play(): void;
  pause(): void;
  seek(sec: number): void;
  setSpeed(s: number): void;
}

export interface TransportApi {
  /**
   * True only while the playhead should ADVANCE and audio should SOUND. While
   * the readiness gate holds (`phase === "buffering"`) this is `false` so the
   * rAF loop freezes and the AudioMixer goes silent — even though the user has
   * "pressed play". Downstream consumers read THIS, not the user's intent.
   */
  playing: boolean;
  /** Transport phase — drives the buffering indicator. */
  phase: TransportPhase;
  /** The playhead frame store — subscribe via `usePlaybackFrame`, or read it
   *  imperatively with `getFrame()`. NOT a reactive field: reading it does not
   *  re-render the caller (that is the whole point — see PreviewSurface). */
  frameStore: FrameStore;
  /** Discrete USER-seek signal — bumps on every `seek()` (scrub/jump). The video
   *  source layer subscribes to HARD-seek (flush + re-decode) the mounted
   *  sources, distinct from the SOFT per-frame playback `seek`. NOT bumped by the
   *  rAF advance. */
  seekSignal: SeekSignalStore;
  /** Current playhead frame, read imperatively (no subscription/re-render). */
  getFrame(): number;
  /** Convenience: `phase === "buffering"`. */
  buffering: boolean;
  speed: number;
  totalFrames: number;
  fps: number;
  /** Tier-0 just-in-time preroll window (seconds). */
  lookaheadSeconds: number;
  /** Layer-B rolling read-ahead target (seconds). */
  readAheadSeconds: number;
  /** 0..1 — master output level applied to every audio source. */
  masterVolume: number;
  masterMuted: boolean;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(frame: number): void;
  setSpeed(speed: number): void;
  setMasterVolume(v: number): void;
  toggleMasterMuted(): void;
}

interface UseTransportOptions {
  totalFrames: number;
  fps: number;
  /**
   * Readiness probe wired in by the editor — min decoded runway (seconds)
   * across the sources required at composition-second `t` (video + active
   * audio). Absent ⇒ no gate (legacy / test behavior): play is instant.
   */
  getReadyAhead?: ReadyAheadProbe;
  /**
   * Video-pacing probe — the active video's REAL decode position (composition
   * seconds) at the current playhead. Absent ⇒ no pacing clamp (legacy / test
   * behavior): the playhead advances by pure wall-clock.
   */
  getActiveVideoTime?: ActiveVideoTimeProbe;
  /**
   * Audio-master control (WebCodecs engine). When provided, the transport reads
   * `frame` from this clock and delegates play/pause/seek/speed to it instead of
   * running the wall-clock rAF advance + readiness gate.
   */
  audioMaster?: AudioMasterControl | null;
}

/**
 * Owns the preview's playback state: frame, playing, speed, plus the
 * raf-driven tick loop. Single source of truth — PreviewPlayer, Timeline,
 * and AudioMixer all read from it.
 */
export function useTransport({
  totalFrames,
  fps,
  getReadyAhead,
  getActiveVideoTime,
  audioMaster,
}: UseTransportOptions): TransportApi {
  // Playhead lives in an external store, NOT React state, so the 30 Hz advance
  // never re-renders the component that calls useTransport (the editor page).
  // Created once via a lazy useState initializer (the create-once idiom that
  // doesn't read a ref during render); the setter is intentionally unused.
  const [frameStore] = useState<FrameStore>(() => createFrameStore(0));
  // Discrete user-seek signal — bumped by `seek()` only, never the rAF advance,
  // so the video-source layer can HARD-seek on a real user scrub/jump.
  const [seekSignal] = useState<SeekSignalStore>(() => createSeekSignalStore());
  // Imperative setter used at every former `setFrame` site. Keeps `frameRef`
  // (the rAF loop's local mirror) and the store in lockstep.
  const commitFrame = useCallback(
    (next: number) => {
      frameRef.current = next;
      frameStore.set(next);
    },
    [frameStore],
  );
  // The phase state machine: idle → (buffering →) playing. `playing`
  // (advance/sound) is DERIVED as `phase === "playing"`. The user's press-play
  // resolves the readiness gate in the event handler itself — straight to
  // playing when already warm, else into buffering, which the polling effect
  // releases. Re-buffer routes playing → buffering when the runway sustainedly
  // collapses.
  const [phase, setPhase] = useState<TransportPhase>("idle");
  const [speed, setSpeedState] = useState(1);
  // Keep the gate probe in a ref so the gate/re-buffer effects read the latest
  // without re-subscribing every render (the editor rebuilds the callback as
  // sources change). Written in the layout-effect mirror below (never during
  // render); every consumer is an effect, tick callback, or event handler, all
  // of which run after layout effects.
  const getReadyAheadRef = useRef<ReadyAheadProbe | undefined>(getReadyAhead);
  // Same ref pattern for the video-pacing probe (the editor rebuilds it as
  // sources change; the tick reads the latest without re-subscribing).
  const getActiveVideoTimeRef = useRef<ActiveVideoTimeProbe | undefined>(getActiveVideoTime);
  // Audio-master control (WebCodecs). Kept in a ref so the rAF tick + controls
  // read the latest without re-subscribing as the editor rebuilds it.
  const audioMasterRef = useRef<AudioMasterControl | null | undefined>(audioMaster);

  const [masterVolume, setMasterVolumeState] = useState<number>(() => {
    if (typeof window === "undefined") return 1;
    const raw = window.localStorage.getItem("libi:preview-volume");
    if (raw == null) return 1;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
  });
  const [masterMuted, setMasterMutedState] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("libi:preview-muted") === "true";
  });

  const totalFramesRef = useRef(totalFrames);
  const speedRef = useRef(speed);
  const fpsRef = useRef(fps);
  const frameRef = useRef(0);
  const phaseRef = useRef(phase);

  // `playing` (advance/sound) is true ONLY in the playing phase — never while
  // the gate holds. Downstream consumers (rAF advance, audio) read this.
  const playing = phase === "playing";

  // Mirror state/props into refs so the tick loop reads the latest values
  // without having to be re-created on every change.
  useLayoutEffect(() => {
    totalFramesRef.current = totalFrames;
    speedRef.current = speed;
    fpsRef.current = fps;
    phaseRef.current = phase;
    getReadyAheadRef.current = getReadyAhead;
    getActiveVideoTimeRef.current = getActiveVideoTime;
    audioMasterRef.current = audioMaster;
  });

  // Raf tick loop — only runs while the phase is `playing` (the gate holds the
  // playhead frozen in idle/buffering: no advance, and the AudioMixer
  // reads the same `playing=false`, so nothing sounds during the gate).
  useEffect(() => {
    if (!playing) return;
    if (totalFramesRef.current <= 0) return;

    // Capture raf/caf at setup time so cleanup uses the same functions
    // that scheduled the frames (matters for tests that stub globals).
    const raf$ = requestAnimationFrame;
    const caf$ = cancelAnimationFrame;

    let raf = 0;
    let lastTime = performance.now();
    let accumulated = 0;
    // Video-pacing clamp bookkeeping: the timestamp we first started holding the
    // counter behind a lagging video (0 = not holding). Resets when the video
    // catches up; latches the MAX_PACE_HOLD_MS no-freeze escape hatch.
    let pacedHoldSince = 0;
    // Track the current frame locally so we don't need to read from React
    // state inside the updater (which may be double-invoked in dev).
    let currentFrame =
      totalFramesRef.current <= 0
        ? 0
        : Math.min(frameRef.current, totalFramesRef.current - 1);

    const tick = (now: number) => {
      // ── Audio-master branch (WebCodecs) ──────────────────────────────────
      // Frame is DERIVED from the audio clock; video chases it (no wall-clock
      // accumulation, no pacing clamp). At end-of-timeline, stop + rewind so the
      // next play starts from 0.
      const am = audioMasterRef.current;
      if (am) {
        const total = totalFramesRef.current;
        const audioT = am.getTime();
        const next = Math.round(audioT * fpsRef.current);
        const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        recordPreviewEvent({
          t: now,
          type: "tick",
          audioTime: audioT,
          frame: next,
          dFrame: next - currentFrame,
          heapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(2) : undefined,
        });
        if (total > 0 && next >= total) {
          am.pause();
          am.seek(0);
          currentFrame = 0;
          commitFrame(0);
          setPhase("idle");
          return; // stop the loop; play() restarts it
        }
        if (next !== currentFrame && next >= 0) {
          currentFrame = next;
          commitFrame(next);
        }
        raf = raf$(tick);
        return;
      }

      const delta = now - lastTime;
      lastTime = now;
      const frameDuration = 1000 / (fpsRef.current * speedRef.current);
      accumulated += delta;

      // Adopt external seeks (scrub during play): divergence means seek()
      // updated frameRef out from under us.
      if (frameRef.current !== currentFrame) {
        currentFrame = Math.min(frameRef.current, totalFramesRef.current - 1);
        accumulated = 0;
      }

      if (accumulated >= frameDuration) {
        const advance = Math.floor(accumulated / frameDuration);
        accumulated -= advance * frameDuration;
        let next = currentFrame + advance;

        // ── Video-pacing clamp (Phase 2) ──────────────────────────────────
        // Cap forward advance so the counter can't run more than PACE_LEAD_S
        // ahead of the active video's REAL decode position. The native decoder
        // paces the playhead, so the canvas never shows a frame the video hasn't
        // produced and the controller's 0.45s steady-playback drift-seek never
        // fires mid-cold-warmup (which is what froze the timecode). No-op for
        // canvas scenes / when no probe is wired (videoTime null) → pure
        // wall-clock. Never rewinds (clamped to >= currentFrame). A hold latch
        // lets a genuinely stuck source play soft rather than freeze forever.
        const videoTime = getActiveVideoTimeRef.current?.(currentFrame) ?? null;
        if (videoTime != null && Number.isFinite(videoTime)) {
          const capFrame = Math.floor((videoTime + PACE_LEAD_S) * fpsRef.current);
          if (next > capFrame) {
            if (pacedHoldSince === 0) pacedHoldSince = now;
            if (now - pacedHoldSince < MAX_PACE_HOLD_MS) {
              next = Math.max(currentFrame, capFrame); // pace to the video
            }
            // else: stuck past the cap — let `next` (wall-clock) through.
          } else {
            pacedHoldSince = 0; // video caught up / is ahead
          }
        } else {
          pacedHoldSince = 0; // nothing to pace to (canvas / no probe)
        }

        if (next !== currentFrame) {
          if (next >= totalFramesRef.current) {
            currentFrame = 0;
            // Keep ref in lock-step with our local counter: the divergence
            // check above must only fire for external seeks, not our own.
            commitFrame(0);
            setPhase("idle");
            return;
          }
          currentFrame = next;
          commitFrame(next);
        }
        // next === currentFrame → held by the pacing clamp; wait for the next tick.
      }

      raf = raf$(tick);
    };

    raf = raf$(tick);
    return () => caf$(raf);
  }, [playing]);

  // The readiness decision, shared by press-play and the buffering poller.
  // Reads only refs, so it is callable from event handlers and timers alike.
  const gateReady = useCallback((): boolean => {
    const probe = getReadyAheadRef.current;
    if (!probe) return true; // no gate wired → always ready
    const t = fpsRef.current > 0 ? frameRef.current / fpsRef.current : 0;
    const { allCanPaint, dominantRunway } = probe(t);
    // Nothing gates (pure canvas comp) → release.
    if (!Number.isFinite(dominantRunway)) return true;
    // Drop-frames release: no source would paint black AND the DOMINANT source
    // has a small runway. Secondary sources dropping frames don't hold us.
    return allCanPaint && dominantRunway >= START_MARGIN_DROP;
  }, []);

  // play() resolves the readiness gate AT EVENT TIME: an already-warm play
  // goes straight to `playing` (instant, never flashes the buffering
  // indicator); a cold one enters `buffering`, which the polling effect below
  // releases. This is the SAME for the audio-master path: the `playing` effect
  // below calls am.play() on release — so a not-yet-warm press-play buffers
  // (spinner) instead of starting soft, and the audio clock is held in
  // lockstep with the video while the gate holds. No-op if already playing or
  // buffering so we don't restart the gate.
  const play = useCallback(() => {
    const p = phaseRef.current;
    if (p === "playing" || p === "buffering") return;
    setPhase(gateReady() ? "playing" : "buffering");
  }, [gateReady]);
  const pause = useCallback(() => {
    audioMasterRef.current?.pause();
    setPhase("idle");
  }, []);
  const toggle = useCallback(() => {
    const isOn = phaseRef.current === "playing" || phaseRef.current === "buffering";
    if (isOn) {
      audioMasterRef.current?.pause();
      setPhase("idle");
    } else {
      // Gate resolved here too; the `playing` effect resumes audio on release.
      setPhase(gateReady() ? "playing" : "buffering");
    }
  }, [gateReady]);

  // ── Audio sounds ONLY while `playing` ─────────────────────────────────────
  // The audio-master clock is the playhead, so audio must pause whenever the
  // phase isn't `playing` — including while the readiness gate HOLDS in
  // buffering. That is the whole backpressure: a decode underrun routes
  // playing → buffering (re-buffer effect), this effect pauses the audio clock,
  // the video tick loop stops (it runs only while playing) — so audio AND video
  // hold together at the same frame, no drift. On release back to `playing` it
  // resumes am.play() from the same clock position. No-op without an audio
  // master (the legacy wall-clock path is unaffected).
  useEffect(() => {
    const am = audioMasterRef.current;
    if (!am) return;
    if (playing) am.play();
    else am.pause();
  }, [playing]);

  // Buffering telemetry: an enter/exit pair per hold, so `summary().buffering`
  // reports how often the gate fires (count/totalMs). ~0 on healthy HW for an
  // easy scene; a high rate = a real underrun the gate is masking. Zero cost
  // when telemetry is off (recordPreviewEvent early-returns).
  useEffect(() => {
    if (phase !== "buffering") return;
    recordPreviewEvent({ t: performance.now(), type: "buffering", label: "enter" });
    return () => {
      recordPreviewEvent({ t: performance.now(), type: "buffering", label: "exit" });
    };
  }, [phase]);

  // Phase-transition trace (mark events) — so a flicker capture shows the
  // idle→buffering→playing churn at play start (a suspected whole-frame
  // flash source). Zero cost when telemetry is off.
  const prevPhaseRef = useRef<TransportPhase>("idle");
  useEffect(() => {
    if (prevPhaseRef.current !== phase) {
      recordPreviewEvent({ t: performance.now(), type: "mark", label: `phase ${prevPhaseRef.current}->${phase}` });
      prevPhaseRef.current = phase;
    }
  }, [phase]);

  // ── Playback readiness gate (buffering poller) ───────────────────────────
  // The warm fast-path already resolved in play()/toggle(); this effect only
  // runs while `buffering`, polling (timer-driven, convergent — never a render
  // loop) until either every required source has START_MARGIN of runway OR the
  // MAX_GATE_MS safety cap elapses, then releases to `playing`. The cap
  // guarantees the gate can NEVER hang playback: a slow source plays
  // possibly-soft rather than freezing the UI forever.
  useEffect(() => {
    if (phase !== "buffering") return;

    const startedAt = performance.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = () => {
      // A pause/seek-driven phase change unmounts this effect; guard anyway.
      if (phaseRef.current !== "buffering") return;
      if (gateReady() || performance.now() - startedAt >= MAX_GATE_MS) {
        setPhase("playing");
        return;
      }
      timer = setTimeout(poll, GATE_POLL_MS);
    };
    timer = setTimeout(poll, GATE_POLL_MS);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [phase, gateReady]);

  // ── Re-buffer on a sustained underrun while playing ───────────────────────
  // A momentary 1-frame dip is covered by the renderer's hold-last-frame — we
  // only re-enter `buffering` if the runway stays below REBUFFER_THRESHOLD for
  // longer than REBUFFER_GRACE_MS, so the spinner can't flap on micro-dips.
  useEffect(() => {
    if (phase !== "playing") return;
    const probe = getReadyAheadRef.current;
    if (!probe) return; // no gate wired → never re-buffer

    let belowSince: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      if (phaseRef.current !== "playing") return;
      const t = fpsRef.current > 0 ? frameRef.current / fpsRef.current : 0;
      // Re-buffer keys off the DOMINANT source ONLY: a small/background PIP
      // dropping frames must never re-buffer the whole composition (it holds
      // last-frame). `dominantRunway` is -1 when the dominant itself can't paint
      // a live frame, which correctly trips the sustained-underrun path.
      const { dominantRunway } = probe(t);
      const low = Number.isFinite(dominantRunway) && dominantRunway < REBUFFER_THRESHOLD;
      if (low) {
        const now = performance.now();
        if (belowSince === null) belowSince = now;
        else if (now - belowSince >= REBUFFER_GRACE_MS) {
          // Sustained underrun — re-arm the gate (→ buffering) to recover.
          setPhase("buffering");
          return;
        }
      } else {
        belowSince = null;
      }
      timer = setTimeout(check, GATE_POLL_MS);
    };
    timer = setTimeout(check, GATE_POLL_MS);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [phase]);

  const seek = useCallback((f: number) => {
    const total = totalFramesRef.current;
    const clamped = total > 0 ? Math.max(0, Math.min(f, total - 1)) : 0;
    // Audio-master: re-anchor the audio clock to the seek target.
    audioMasterRef.current?.seek(fpsRef.current > 0 ? clamped / fpsRef.current : 0);
    // Sync the rAF tick's external-seek detector + the store in one shot.
    // (commitFrame writes frameRef BEFORE the store notify, so the tick sees it.)
    commitFrame(clamped);
    // Fire the discrete user-seek signal AFTER the frame is committed so a
    // subscriber that reads the frame store sees the landed value. This is what
    // hard-seeks the video sources (flush stale warm/ahead frames) so a jump or
    // scrub lands on the target frame with no replay.
    seekSignal.bump(clamped);
  }, [commitFrame, seekSignal]);

  const setSpeed = useCallback((s: number) => {
    audioMasterRef.current?.setSpeed(s);
    setSpeedState(s);
  }, []);

  const setMasterVolume = useCallback((v: number) => {
    const clamped = Math.min(1, Math.max(0, Number.isNaN(v) ? 0 : v));
    setMasterVolumeState(clamped);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("libi:preview-volume", String(clamped));
    }
  }, []);

  const toggleMasterMuted = useCallback(() => {
    setMasterMutedState((m) => {
      const next = !m;
      if (typeof window !== "undefined") {
        window.localStorage.setItem("libi:preview-muted", String(next));
      }
      return next;
    });
  }, []);

  const getFrame = useCallback((): number => {
    const total = totalFramesRef.current;
    const raw = frameStore.get();
    return total <= 0 ? 0 : Math.min(raw, total - 1);
  }, [frameStore]);

  return {
    frameStore,
    seekSignal,
    getFrame,
    playing,
    phase,
    buffering: phase === "buffering",
    speed,
    totalFrames,
    fps,
    lookaheadSeconds: PREROLL_LOOKAHEAD_SECONDS,
    readAheadSeconds: LOOKAHEAD_SECONDS,
    masterVolume,
    masterMuted,
    play,
    pause,
    toggle,
    seek,
    setSpeed,
    setMasterVolume,
    toggleMasterMuted,
  };
}
