"use client";

import type { AudioClip } from "@/lib/engine/types";
import { clipGainView } from "@/lib/audio/clip-gain-view";

/**
 * The clip's gain and volume envelope drawn over its waveform on the timeline:
 * a line of the level in dB (a flat line at the gain when there is no envelope),
 * a dashed 0 dB reference and a diamond per key. Display only: the envelope is
 * edited through the agent's `libi.add_keyframe({ clipId })`. Renders nothing for
 * a clip with no gain and no envelope.
 */
export function ClipGainOverlay({
  clip,
}: {
  clip: Pick<AudioClip, "duration" | "gainDb" | "volumeKeyframes" | "crossfadeMs">;
}) {
  const view = clipGainView(clip);
  if (!view) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[5]" data-testid="clip-gain-envelope" title={view.label}>
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        <line x1="0" x2="100" y1={view.zeroY} y2={view.zeroY} stroke="rgba(255,255,255,0.25)" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        <polyline points={view.points} fill="none" stroke="rgb(251 191 36)" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      {view.keys.map((k, i) => (
        <span
          key={i}
          className="absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-amber-400"
          style={{ left: `${k.x}%`, top: `${k.y}%` }}
        />
      ))}
      <span className="absolute right-1 top-0 rounded-sm bg-black/50 px-1 text-[8px] leading-3 text-amber-300">{view.label}</span>
    </div>
  );
}
