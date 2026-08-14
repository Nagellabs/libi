// lib/effects/audio-envelope.ts
import type { LayerEffects } from "./types";
import { inProgress, outProgress } from "./phase-timing";

interface AudioFadeClip {
  startTime: number;
  duration: number;
  effects?: LayerEffects;
}

/** Gain multiplier 0..1 at a composition-global time, from a clip's in/out
 *  audio-fade effects. 1 when no fades. */
export function audioGainAt(clip: AudioFadeClip, globalTime: number): number {
  const fx = clip.effects;
  if (!fx) return 1;
  let gain = 1;
  if (fx.in?.effectId === "audio-fade-in") {
    gain *= inProgress(globalTime, clip.startTime, clip.duration, fx.in.durationMs);
  }
  if (fx.out?.effectId === "audio-fade-out") {
    gain *= 1 - outProgress(globalTime, clip.startTime, clip.duration, fx.out.durationMs);
  }
  return gain;
}

/** Fade lengths in seconds for the ffmpeg afade builder (0 when absent). */
export function audioFadeSeconds(clip: AudioFadeClip): { inSec: number; outSec: number } {
  const fx = clip.effects;
  const reqIn = fx?.in?.effectId === "audio-fade-in" ? (fx.in.durationMs ?? 600) / 1000 : 0;
  const reqOut = fx?.out?.effectId === "audio-fade-out" ? (fx.out.durationMs ?? 600) / 1000 : 0;
  return {
    inSec: Math.min(reqIn, clip.duration),
    outSec: Math.min(reqOut, clip.duration),
  };
}
