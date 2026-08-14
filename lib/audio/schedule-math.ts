/**
 * Pure scheduling math for the audio-master WebAudio engine. Dependency-free
 * (no AudioContext / mediabunny) so it is unit-testable. Maps composition time
 * to AudioContext time and computes, for a clip, the source-local audio range
 * that still needs scheduling from a given playhead.
 */

export interface ScheduleClip {
  /** Composition second the clip starts sounding. */
  startTime: number;
  /** Clip length in composition seconds. */
  duration: number;
  /** Source-local second the clip's audio starts at (trim in). */
  trimStart: number;
}

/**
 * AudioContext time at which a given composition time should occur, given the
 * play anchor (`anchorComp` composition-sec mapped to `anchorCtx` ctx-sec) and
 * playback `speed`. At speed 2, composition advances twice as fast, so the ctx
 * interval is halved.
 */
export function compToCtxTime(
  compTime: number,
  anchorComp: number,
  anchorCtx: number,
  speed: number = 1,
): number {
  return anchorCtx + (compTime - anchorComp) / speed;
}

/**
 * The source-local audio range `[sourceStart, sourceEnd]` of `clip` that still
 * needs scheduling when the playhead is at `fromCompTime`. Returns null when the
 * clip has already finished (its whole window is in the past). When the playhead
 * is before the clip, the full clip is returned (from its trim-in).
 */
export function clipSourceRange(
  clip: ScheduleClip,
  fromCompTime: number,
): { sourceStart: number; sourceEnd: number; compStart: number } | null {
  const compEnd = clip.startTime + clip.duration;
  if (fromCompTime >= compEnd) return null; // fully past
  const compStart = Math.max(clip.startTime, fromCompTime);
  const sourceStart = clip.trimStart + (compStart - clip.startTime);
  const sourceEnd = clip.trimStart + clip.duration;
  return { sourceStart, sourceEnd, compStart };
}

/** Crossfade ramp (seconds) at each clip edge so back-to-back clips don't click. */
export const AUDIO_CROSSFADE_S = 0.02;

/**
 * Linear fade multiplier (0..1) for `localSec` seconds into a clip of
 * `durationSec`. Full level in the middle; ramps over AUDIO_CROSSFADE_S at each
 * edge. Mirrors the legacy mixer's crossfadeGain.
 */
export function crossfadeGain(localSec: number, durationSec: number): number {
  if (durationSec <= 0) return 1;
  const ramp = Math.min(AUDIO_CROSSFADE_S, durationSec / 2);
  if (ramp <= 0) return 1;
  if (localSec < ramp) return Math.max(0, localSec / ramp);
  if (localSec > durationSec - ramp) return Math.max(0, (durationSec - localSec) / ramp);
  return 1;
}
