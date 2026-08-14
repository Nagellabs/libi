/** Beat-time helpers injected into the canvas scene draw scope. The agent
 *  inlines the beat-times array into its draw function literally:
 *
 *    const BEATS = [0.42, 0.83, 1.25, ...];
 *    const p = beatPulse(BEATS, time);
 *    drawCircle(ctx, w/2, h/2, 160 + 80 * p, "#60a5fa");
 *
 *  These functions are pure, side-effect-free, and tolerant of the
 *  rough-edge inputs the agent will produce — empty arrays, t outside
 *  the beat range, unsorted beats. */

export interface NearestBeatResult {
  /** Absolute time of the nearest beat, in seconds. */
  time: number;
  /** Index into the beatTimes array. -1 for empty inputs. */
  index: number;
  /** |t - time|, always >= 0. Infinity for empty inputs. */
  distance: number;
}

/** Linear scan because we expect at most a few hundred beats per piece
 *  and inlining a binary search would obscure the intent without a
 *  measurable win at this scale. */
export function nearestBeat(beatTimes: number[], t: number): NearestBeatResult {
  if (beatTimes.length === 0) return { time: NaN, index: -1, distance: Infinity };
  let bestIdx = 0;
  let bestDist = Math.abs(beatTimes[0] - t);
  for (let i = 1; i < beatTimes.length; i++) {
    const d = Math.abs(beatTimes[i] - t);
    if (d < bestDist) {
      bestIdx = i;
      bestDist = d;
    }
  }
  return { time: beatTimes[bestIdx], index: bestIdx, distance: bestDist };
}

export interface BeatPulseOpts {
  /** Pre-beat ramp-up in seconds. Default 0.030. */
  attack?: number;
  /** Post-beat decay in seconds. Default 0.250. */
  release?: number;
}

/** Triangular envelope: 0 → 1 over `attack` seconds before the nearest
 *  beat, 1 → 0 over `release` seconds after. 0 elsewhere. Returns 0..1. */
export function beatPulse(beatTimes: number[], t: number, opts?: BeatPulseOpts): number {
  if (beatTimes.length === 0) return 0;
  const attack = opts?.attack ?? 0.03;
  const release = opts?.release ?? 0.25;
  const n = nearestBeat(beatTimes, t);
  const offset = t - n.time; // negative when before the beat
  if (offset < 0) {
    if (-offset > attack) return 0;
    return 1 + offset / attack; // -attack → 0, 0 → 1
  }
  if (offset > release) return 0;
  return 1 - offset / release; // 0 → 1, release → 0
}
