import type { AudioClip } from "@/lib/engine/types";

export interface MasterAudioState {
  masterVolume: number;
  masterMuted: boolean;
}

/** Clips that should be producing sound at composition time `t` (seconds).
 *  End is exclusive so back-to-back clips don't both fire at the seam. */
export function activeClipsAt(clips: AudioClip[], t: number): AudioClip[] {
  return clips.filter((c) => c.enabled && t >= c.startTime && t < c.startTime + c.duration);
}

/** The level the `<audio>` element should be set to. Combines per-clip
 *  volume, master volume, master mute, and per-clip enabled flag. */
export function effectiveVolume(clip: AudioClip, master: MasterAudioState): number {
  if (!clip.enabled) return 0;
  if (master.masterMuted) return 0;
  return clamp01(clip.volume) * clamp01(master.masterVolume);
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
