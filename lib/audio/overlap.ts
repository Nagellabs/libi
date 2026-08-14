import type { AudioClip } from "@/lib/engine/types";

/** Peak count of clips that overlap at any single instant. Used to drive
 *  the timeline's perf warning. Sweep-line over start/end events. */
export function maxOverlap(clips: AudioClip[]): number {
  const events: Array<{ t: number; d: number }> = [];
  for (const c of clips) {
    events.push({ t: c.startTime, d: 1 });
    events.push({ t: c.startTime + c.duration, d: -1 });
  }
  events.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0;
  let peak = 0;
  for (const e of events) {
    cur += e.d;
    if (cur > peak) peak = cur;
  }
  return peak;
}
