import type { AudioClip } from "@/lib/engine/types";
import { valueAt } from "@/lib/engine/animatable";
import type { ElementTiming } from "@/lib/engine/overlay-timing";
import { audioGainAt } from "@/lib/effects/audio-envelope";

/**
 * THE clip-gain law: what level an audio clip plays at, at a given timeline
 * time, from its `volume`, `gainDb`, volume envelope (`volumeKeyframes`),
 * crossfades and in/out fades.
 *
 * Two places apply a clip's level: the preview (Web Audio gain automation,
 * `lib/audio/web-audio-engine.ts`) and the export (ffmpeg,
 * `lib/export/audio-mix.ts` + `lib/export/gain-envelopes.ts`). Both read THIS
 * module, so they cannot drift (the duck bug was exactly two implementations
 * of one idea: `lib/audio/duck-law.ts`).
 *
 *   gain(t) = volume × 10^(gainDb/20)          static   (`staticGain`)
 *           × 10^(envelopeDb(t)/20)            keys     (`envelopeDbAt`)
 *           × crossfade(t)                     overlap  (`crossfadePlan`)
 *           × fades(t)                         effects  (`audioGainAt`)
 *
 * The first factor is a constant, the fades are the existing `afade` pair, and
 * the middle two (the "shape") are what the export renders as an envelope
 * track (`shapeGainAt`). Ducking is a separate stage after all of this
 * (`duck-law.ts`), and the preview's 20 ms edge ramp (`crossfadeGain`) is the
 * click guard the preview alone adds.
 *
 * Time domains: everything here takes COMPOSITION-global seconds; a keyframe's
 * `t` is seconds from the clip's start.
 */

export const GAIN_DB_MIN = -60;
export const GAIN_DB_MAX = 12;
/** An envelope key's dB offset has the same bounds as the static gain. */
export const KEY_DB_MIN = GAIN_DB_MIN;
export const KEY_DB_MAX = GAIN_DB_MAX;
export const CROSSFADE_MS_MAX = 5000;
/** Floor of the dB scale: this and below is silence, not 0.001. */
export const SILENT_DB = GAIN_DB_MIN;
/** Total envelope + static dB is never boosted past this (two +12 add up). */
const TOTAL_DB_CEILING = GAIN_DB_MAX * 2;

export function dbToGain(db: number): number {
  if (!Number.isFinite(db)) return 1;
  if (db <= SILENT_DB) return 0;
  return Math.pow(10, Math.min(db, TOTAL_DB_CEILING) / 20);
}

/** Linear gain → dB, for display. 0 → -Infinity. */
export function gainToDb(gain: number): number {
  return gain <= 0 ? -Infinity : 20 * Math.log10(gain);
}

/** The fields of an AudioClip this module reads. */
export type GainClip = Pick<AudioClip, "startTime" | "duration" | "volume"> &
  Partial<Pick<AudioClip, "id" | "fileId" | "enabled" | "gainDb" | "volumeKeyframes" | "crossfadeMs" | "effects">>;

const clamp01 = (n: number): number => (Number.isNaN(n) ? 0 : Math.min(1, Math.max(0, n)));

/** `volume` × the static gain. The constant factor of the law. */
export function staticGain(clip: Pick<GainClip, "volume" | "gainDb">): number {
  return clamp01(clip.volume) * dbToGain(clip.gainDb ?? 0);
}

/** A clip's keyframe track is `t` in SECONDS; `valueAt` reads `progress`. */
function timingAt(seconds: number): ElementTiming {
  return { frame: 0, time: 0, totalFrames: 1, duration: 1, progress: seconds };
}

/** The envelope's dB offset at `localSec` seconds from the clip's start (0 with no keys). */
export function envelopeDbAt(clip: Pick<GainClip, "volumeKeyframes">, localSec: number): number {
  const track = clip.volumeKeyframes;
  if (!track || track.keyframes.length === 0) return 0;
  const db = valueAt(track, timingAt(localSec));
  return Number.isFinite(db) ? db : 0;
}

/** True when the clip carries a volume envelope. */
export function hasEnvelope(clip: Pick<GainClip, "volumeKeyframes">): boolean {
  return (clip.volumeKeyframes?.keyframes.length ?? 0) > 0;
}

// ── Crossfades ──────────────────────────────────────────────────────────────

/** A window of composition seconds a crossfade ramp runs over. */
export interface FadeWindow {
  start: number;
  end: number;
}

export interface ClipCrossfade {
  /** This clip fades IN over this window (it has `crossfadeMs` and an earlier clip overlaps it). */
  in?: FadeWindow;
  /** This clip fades OUT over each of these (a later clip crossfades over it), silent after. */
  outs: FadeWindow[];
}

/** clip id → its crossfade windows. A clip with none is absent. */
export type CrossfadePlan = Map<string, ClipCrossfade>;

/** Overlaps shorter than this are no overlap (a butt joint, float noise). */
const MIN_OVERLAP_S = 0.001;

/**
 * Work out every crossfade among `clips` (disabled ones are ignored).
 *
 * A clip B with `crossfadeMs` crossfades over the EARLIER clip A of the same
 * `fileId` that overlaps B's start (the nearest such start wins): over
 * w = min(crossfadeMs, overlap, B's length, A's length) from B's start, B ramps
 * 0→1 and A ramps 1→0 — linearly in amplitude, which sums to unity for the
 * coherent material a splice is made of — and A stays silent after the window.
 * With no overlapping earlier clip B is untouched: a crossfade needs both
 * halves of the overlap, so there is nothing to fade against.
 */
export function crossfadePlan(clips: readonly GainClip[]): CrossfadePlan {
  const plan: CrossfadePlan = new Map();
  const live = clips.filter((c) => c.enabled !== false && c.id !== undefined);
  for (const b of live) {
    const ms = b.crossfadeMs ?? 0;
    if (!(ms > 0)) continue;
    let a: GainClip | null = null;
    for (const c of live) {
      if (c === b || c.fileId !== b.fileId || !(c.startTime < b.startTime)) continue;
      if (c.startTime + c.duration - b.startTime < MIN_OVERLAP_S) continue;
      if (!a || c.startTime > a.startTime) a = c;
    }
    if (!a) continue;
    const overlap = a.startTime + a.duration - b.startTime;
    const w = Math.min(Math.min(ms, CROSSFADE_MS_MAX) / 1000, overlap, b.duration, a.duration);
    if (!(w > 0)) continue;
    const win: FadeWindow = { start: b.startTime, end: b.startTime + w };
    const bPlan = plan.get(b.id!) ?? { outs: [] };
    bPlan.in = win;
    plan.set(b.id!, bPlan);
    const aPlan = plan.get(a.id!) ?? { outs: [] };
    aPlan.outs.push(win);
    plan.set(a.id!, aPlan);
  }
  return plan;
}

function crossfadeAt(x: ClipCrossfade | undefined, t: number): number {
  if (!x) return 1;
  let g = 1;
  if (x.in) g *= clamp01((t - x.in.start) / (x.in.end - x.in.start));
  for (const o of x.outs) {
    if (t <= o.start) continue;
    g *= t >= o.end ? 0 : 1 - (t - o.start) / (o.end - o.start);
  }
  return g;
}

// ── The law ────────────────────────────────────────────────────────────────

/** True when a clip's level is not just `staticGain`: it has an envelope or a crossfade. */
export function hasGainShape(clip: GainClip, plan: CrossfadePlan): boolean {
  return hasEnvelope(clip) || (clip.id !== undefined && plan.has(clip.id));
}

/** True when nothing about the clip's level differs from plain `volume`. */
export function isPlainVolume(clip: GainClip, plan: CrossfadePlan): boolean {
  return !(clip.gainDb) && !hasGainShape(clip, plan);
}

/** The envelope and crossfade factors at composition time `t` (1 when the clip has neither). */
export function shapeGainAt(clip: GainClip, plan: CrossfadePlan, t: number): number {
  const env = hasEnvelope(clip) ? dbToGain(envelopeDbAt(clip, t - clip.startTime)) : 1;
  return env * crossfadeAt(clip.id !== undefined ? plan.get(clip.id) : undefined, t);
}

/**
 * The clip's whole level at composition time `t`, before ducking and before the
 * preview's 20 ms edge ramp. Outside the clip's window it is still evaluated
 * (the callers only ask inside it).
 */
export function clipGainAt(clip: GainClip, plan: CrossfadePlan, t: number): number {
  return staticGain(clip) * shapeGainAt(clip, plan, t) * audioGainAt(clip, t);
}

/**
 * `count` evenly spaced samples of `value(t)` from `from`, `step` seconds apart
 * (sample i is at from + i×step). The one place a curve becomes numbers, for the
 * preview's `setValueCurveAtTime` and the export's envelope track alike.
 */
export function sampleCurve(value: (t: number) => number, from: number, step: number, count: number): Float32Array {
  const out = new Float32Array(Math.max(0, count));
  for (let i = 0; i < out.length; i++) out[i] = value(from + i * step);
  return out;
}

/** The export evaluates a clip's level on a 1 kHz grid and interpolates between. */
export const GAIN_GRID_RATE = 1000;

/**
 * `level(t)` for composition times from `startSec` for `durationSec`, every
 * 1/GAIN_GRID_RATE s, plus one point past the end so `gridAt` can interpolate
 * the last sample. Cheap enough to run per clip (a 3-minute clip is 180k
 * evaluations) where evaluating at the audio rate (8M) is not.
 */
export function gainGrid(level: (t: number) => number, startSec: number, durationSec: number): Float32Array {
  const n = Math.max(2, Math.ceil(durationSec * GAIN_GRID_RATE) + 2);
  return sampleCurve(level, startSec, 1 / GAIN_GRID_RATE, n);
}

/** The grid's value `localSec` seconds after its start, linearly interpolated; the ends hold. */
export function gridAt(grid: Float32Array, localSec: number): number {
  const x = localSec * GAIN_GRID_RATE;
  if (x <= 0) return grid[0];
  const i = Math.floor(x);
  if (i >= grid.length - 1) return grid[grid.length - 1];
  const f = x - i;
  return grid[i] * (1 - f) + grid[i + 1] * f;
}

// ── Sanitising what a manifest carries ─────────────────────────────────────

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Normalise a clip's B3 fields in place on load, so a hand-edited or old
 * manifest cannot feed the law a NaN or an unsorted track: `gainDb` clamped (and
 * dropped at 0), `crossfadeMs` clamped (dropped at 0), keyframes kept only when
 * well-formed, sorted by time with the last of any shared time winning (dB
 * clamped), the track dropped when nothing is left.
 */
export function sanitizeClipGain(clip: Partial<Pick<AudioClip, "gainDb" | "volumeKeyframes" | "crossfadeMs">>): void {
  if (clip.gainDb !== undefined) {
    if (!finite(clip.gainDb)) delete clip.gainDb;
    else {
      const db = Math.min(GAIN_DB_MAX, Math.max(GAIN_DB_MIN, clip.gainDb));
      if (db === 0) delete clip.gainDb;
      else clip.gainDb = db;
    }
  }
  if (clip.crossfadeMs !== undefined) {
    if (!finite(clip.crossfadeMs) || clip.crossfadeMs <= 0) delete clip.crossfadeMs;
    else clip.crossfadeMs = Math.min(CROSSFADE_MS_MAX, clip.crossfadeMs);
  }
  if (clip.volumeKeyframes !== undefined) {
    const raw = (clip.volumeKeyframes as { keyframes?: unknown } | null)?.keyframes;
    const byTime = new Map<number, { t: number; value: number; easing?: string }>();
    if (Array.isArray(raw)) {
      for (const k of raw as Array<{ t?: unknown; value?: unknown; easing?: unknown }>) {
        if (!k || !finite(k.t) || !finite(k.value) || k.t < 0) continue;
        byTime.set(k.t, {
          t: k.t,
          value: Math.min(KEY_DB_MAX, Math.max(KEY_DB_MIN, k.value)),
          ...(typeof k.easing === "string" && k.easing ? { easing: k.easing } : {}),
        });
      }
    }
    const keys = [...byTime.values()].sort((a, b) => a.t - b.t);
    if (keys.length === 0) delete clip.volumeKeyframes;
    else clip.volumeKeyframes = { keyframes: keys };
  }
}

// ── Editing the envelope ───────────────────────────────────────────────────

/** Keys within this many seconds are one key (an edit "on" a key replaces it). */
export const KEY_SNAP_S = 0.005;

/** Insert or replace the key at `t` (a key within KEY_SNAP_S is replaced, keeping its `t`). Returns a new track. */
export function upsertVolumeKey(
  track: AudioClip["volumeKeyframes"],
  t: number,
  db: number,
  easing?: string,
): NonNullable<AudioClip["volumeKeyframes"]> {
  const keys = (track?.keyframes ?? []).map((k) => ({ ...k }));
  let at = -1;
  let best = Infinity;
  keys.forEach((k, i) => {
    const d = Math.abs(k.t - t);
    if (d <= KEY_SNAP_S && d < best) { best = d; at = i; }
  });
  const value = Math.min(KEY_DB_MAX, Math.max(KEY_DB_MIN, db));
  if (at === -1) keys.push({ t, value, ...(easing ? { easing } : {}) });
  else keys[at] = { ...keys[at], value, ...(easing ? { easing } : {}) };
  keys.sort((a, b) => a.t - b.t);
  return { keyframes: keys };
}

/** The index of the key nearest to `t` within KEY_SNAP_S, or -1. */
export function volumeKeyIndexAt(track: AudioClip["volumeKeyframes"], t: number): number {
  let at = -1;
  let best = Infinity;
  (track?.keyframes ?? []).forEach((k, i) => {
    const d = Math.abs(k.t - t);
    if (d <= KEY_SNAP_S && d < best) { best = d; at = i; }
  });
  return at;
}

/**
 * Cut a clip's envelope at `localSec` (seconds from its start) for a split. The
 * head keeps every key (the first one past the cut stays too: beyond the clip's
 * end it only defines the slope, so the head plays exactly as before). The tail
 * gets a key at its start holding the envelope's value there, then the later
 * keys shifted to its own start, so neither half jumps. Null when there is no
 * envelope.
 */
export function splitVolumeKeyframes(
  clip: Pick<GainClip, "volumeKeyframes">,
  localSec: number,
): { head: NonNullable<AudioClip["volumeKeyframes"]>; tail: NonNullable<AudioClip["volumeKeyframes"]> } | null {
  const track = clip.volumeKeyframes;
  if (!track || track.keyframes.length === 0) return null;
  const at = envelopeDbAt(clip, localSec);
  const keys = [...track.keyframes].sort((a, b) => a.t - b.t);
  const upTo = keys.filter((k) => k.t <= localSec + 1e-9);
  const after = keys.filter((k) => k.t > localSec + 1e-9);
  const governing = [...keys.filter((k) => k.t < localSec - 1e-9)].pop();
  const head = [...upTo.map((k) => ({ ...k })), ...(after.length ? [{ ...after[0] }] : [])];
  const tail = [
    { t: 0, value: at, ...(governing?.easing ? { easing: governing.easing } : {}) },
    ...after.map((k) => ({ ...k, t: k.t - localSec })),
  ];
  return { head: { keyframes: head }, tail: { keyframes: tail } };
}
