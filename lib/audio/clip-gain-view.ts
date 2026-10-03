import type { AudioClip } from "@/lib/engine/types";
import { envelopeDbAt, hasEnvelope } from "@/lib/audio/clip-gain";

/**
 * What the timeline draws over an audio clip's waveform: a polyline of the
 * clip's level in dB (static `gainDb` + the volume envelope) across its width,
 * a faint 0 dB line, and a diamond at each envelope key. Pure, so the shape is
 * testable without a canvas. Coordinates are percentages of the clip's box
 * (x: 0 = clip start, 100 = clip end; y: 0 = top).
 */

/** The dB the box spans: the bottom edge is -30 dB, the top +15 dB. */
export const VIEW_DB_MIN = -30;
export const VIEW_DB_MAX = 15;

const yOf = (db: number): number => {
  const clamped = Math.min(VIEW_DB_MAX, Math.max(VIEW_DB_MIN, db));
  return ((VIEW_DB_MAX - clamped) / (VIEW_DB_MAX - VIEW_DB_MIN)) * 100;
};

export interface ClipGainView {
  /** `x,y x,y …` for an SVG polyline in a 100×100 viewBox. */
  points: string;
  /** y of the 0 dB line. */
  zeroY: number;
  keys: { x: number; y: number }[];
  /** Short text for the clip's title and the box's corner: "+4 dB · 4 keys". */
  label: string;
}

/** Null for a clip with no gain and no envelope: nothing to draw. */
export function clipGainView(
  clip: Pick<AudioClip, "duration" | "gainDb" | "volumeKeyframes" | "crossfadeMs">,
  samples = 96,
): ClipGainView | null {
  const gain = clip.gainDb ?? 0;
  const keys = clip.volumeKeyframes?.keyframes ?? [];
  const xfade = clip.crossfadeMs ?? 0;
  if (gain === 0 && keys.length === 0 && !(xfade > 0)) return null;
  const dur = clip.duration > 0 ? clip.duration : 1;
  const levelDb = (sec: number): number => gain + (hasEnvelope(clip) ? envelopeDbAt(clip, sec) : 0);
  const pts: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const x = (i / samples) * 100;
    pts.push(`${round(x)},${round(yOf(levelDb((i / samples) * dur)))}`);
  }
  const parts: string[] = [];
  if (gain !== 0) parts.push(`${gain > 0 ? "+" : ""}${round(gain)} dB`);
  if (keys.length > 0) parts.push(`${keys.length} key${keys.length === 1 ? "" : "s"}`);
  if (xfade > 0) parts.push(`xfade ${round(xfade)} ms`);
  return {
    points: pts.join(" "),
    zeroY: yOf(0),
    keys: keys
      .filter((k) => k.t >= 0 && k.t <= dur)
      .map((k) => ({ x: round((k.t / dur) * 100), y: round(yOf(gain + k.value)) })),
    label: parts.join(" · "),
  };
}

const round = (n: number): number => Math.round(n * 100) / 100;
