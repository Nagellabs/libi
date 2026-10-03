/**
 * The compact, human-readable diff `libi.apply_ops` reports per piece: one line per change, never a manifest.
 *
 *   overlay text-1: rect 90,1170→90,1250
 *   overlay vid-1: duration 8→11, trim 0–8→0–11
 *   audio clip $music=clip_x added 10.38–79.48 vol 0.4
 *   audio clip clip_x: duck on (sidechain clip_a; -5 dB)
 *
 * Pure: two manifests (plus the ids the batch bound to names) in, lines out.
 */
import type { CompositionManifest, PersistedAudioClip, PersistedOverlay } from "@/lib/composition/persistence";

/** Lines kept per piece; the rest are summarised in one closing line. */
export const DIFF_LINE_CAP = 40;

/** Fields that change on every save or are not an edit the agent made. */
const IGNORED_FIELDS = new Set(["version"]);

const round = (n: number): string => String(Math.round(n * 100) / 100);

function short(v: unknown, max = 48): string {
  const text = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? "undefined";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function scalar(v: unknown): string {
  if (typeof v === "number") return round(v);
  if (v === undefined) return "unset";
  return short(v);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
const isRect = (v: unknown): v is Rect =>
  isRecord(v) && ["x", "y", "width", "height"].every((k) => typeof v[k] === "number");

function rectText(r: Rect, withSize: boolean): string {
  return `${round(r.x)},${round(r.y)}${withSize ? ` ${round(r.width)}x${round(r.height)}` : ""}`;
}

function keyframeCounts(v: unknown): string {
  if (!isRecord(v)) return "none";
  const parts = Object.entries(v).map(([track, t]) => {
    const n = isRecord(t) && Array.isArray(t.keyframes) ? t.keyframes.length : 0;
    return `${track} ${n}`;
  });
  return parts.length ? parts.join(", ") : "none";
}

/** One changed field as text, or several when an object field changed in several places. */
function fieldChanges(key: string, before: unknown, after: unknown, depth = 0): string[] {
  if (IGNORED_FIELDS.has(key) || same(before, after)) return [];
  const name = { startTime: "start", duration: "duration", displayName: "name" }[key] ?? key;
  if (key === "rect" && isRect(before) && isRect(after)) {
    const sizeChanged = before.width !== after.width || before.height !== after.height;
    return [`rect ${rectText(before, sizeChanged)}→${rectText(after, sizeChanged)}`];
  }
  if (key === "trim" && isRecord(before) && isRecord(after)) {
    return [`trim ${scalar(before.start)}–${scalar(before.end)}→${scalar(after.start)}–${scalar(after.end)}`];
  }
  if (key === "keyframes") return [`keyframes ${keyframeCounts(before)}→${keyframeCounts(after)}`];
  if (key === "drawFunction" || key === "sceneFunction" || key === "body") return [`${key} changed`];
  if (isRecord(before) && isRecord(after) && depth < 2) {
    const out: string[] = [];
    for (const sub of new Set([...Object.keys(before), ...Object.keys(after)])) {
      for (const line of fieldChanges(sub, before[sub], after[sub], depth + 1)) out.push(`${key}.${line}`);
    }
    return out;
  }
  return [`${name} ${scalar(before)}→${scalar(after)}`];
}

function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  // Timing first, then the rest in a stable order, so lines read the same across pieces.
  const order = ["startTime", "duration", "trim", "rect"];
  const sorted = [...keys].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib) || a.localeCompare(b);
  });
  for (const key of sorted) out.push(...fieldChanges(key, before[key], after[key]));
  return out;
}

function span(start: unknown, duration: unknown): string {
  if (typeof start !== "number" || typeof duration !== "number") return "";
  return `${round(start)}–${round(start + duration)}`;
}

function gainText(db: number | undefined): string {
  return typeof db === "number" && db !== 0 ? `gain ${db > 0 ? "+" : ""}${round(db)} dB` : "";
}

function envelopeText(track: PersistedAudioClip["volumeKeyframes"]): string {
  const n = track?.keyframes?.length ?? 0;
  return n > 0 ? `envelope ${n} key${n === 1 ? "" : "s"}` : "";
}

function crossfadeText(ms: number | undefined): string {
  return typeof ms === "number" && ms > 0 ? `crossfade ${round(ms)} ms` : "";
}

function duckText(d: unknown): string {
  if (!isRecord(d)) return "";
  const side = Array.isArray(d.sidechainClipIds) ? d.sidechainClipIds.join(",") : "";
  const parts = [side ? `sidechain ${side}` : "", typeof d.reductionDb === "number" ? `${round(d.reductionDb)} dB` : ""].filter(Boolean);
  return parts.length ? ` (${parts.join("; ")})` : "";
}

/**
 * The lines describing what turned `before` into `after`. `bound` maps a binding name to the id the batch
 * gave it on THIS piece, so an id the agent refers to as `$music` reads as `$music=clip_x`.
 */
export function diffManifests(
  before: CompositionManifest,
  after: CompositionManifest,
  bound: Readonly<Record<string, string>> = {},
): string[] {
  const nameOf = new Map(Object.entries(bound).map(([name, id]) => [id, name]));
  const label = (id: string) => (nameOf.has(id) ? `$${nameOf.get(id)}=${id}` : id);
  const lines: string[] = [];

  if (before.width !== after.width || before.height !== after.height) {
    lines.push(`canvas ${before.width}x${before.height}→${after.width}x${after.height}`);
  }
  if (before.fps !== after.fps) lines.push(`fps ${before.fps}→${after.fps}`);
  // Anything else at the top of the manifest (pending template music, …) is named, not itemised.
  const topKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of ["width", "height", "fps", "overlays", "audioClips"]) topKeys.delete(key);
  for (const key of topKeys) {
    if (!same((before as unknown as Record<string, unknown>)[key], (after as unknown as Record<string, unknown>)[key])) lines.push(`${key} changed`);
  }

  const beforeOverlays = new Map<string, PersistedOverlay>((before.overlays ?? []).map((o) => [o.id, o]));
  const afterOverlays = new Map<string, PersistedOverlay>((after.overlays ?? []).map((o) => [o.id, o]));
  for (const [id, o] of afterOverlays) {
    const was = beforeOverlays.get(id);
    if (!was) {
      const text = o.kind === "text" && typeof o.content === "string" ? ` ${short(o.content, 32)}` : "";
      lines.push(`overlay ${label(id)} added (${o.kind}${text} ${span(o.startTime, o.duration)})`.replace(/ \)$/, ")"));
      continue;
    }
    const changes = changedFields(was as unknown as Record<string, unknown>, o as unknown as Record<string, unknown>);
    if (changes.length) lines.push(`overlay ${label(id)}: ${changes.join(", ")}`);
  }
  for (const id of beforeOverlays.keys()) if (!afterOverlays.has(id)) lines.push(`overlay ${label(id)} removed`);

  const beforeClips = new Map<string, PersistedAudioClip>((before.audioClips ?? []).map((c) => [c.id, c]));
  const afterClips = new Map<string, PersistedAudioClip>((after.audioClips ?? []).map((c) => [c.id, c]));
  for (const [id, c] of afterClips) {
    const was = beforeClips.get(id);
    if (!was) {
      const vol = typeof c.volume === "number" && c.volume !== 1 ? ` vol ${round(c.volume)}` : "";
      const shape = [gainText(c.gainDb), envelopeText(c.volumeKeyframes), crossfadeText(c.crossfadeMs)].filter(Boolean).join(", ");
      lines.push(`audio clip ${label(id)} added ${span(c.startTime, c.duration)}${vol}${shape ? ` ${shape}` : ""}${c.duck ? ` duck${duckText(c.duck)}` : ""}`);
      continue;
    }
    const { duck: wasDuck, gainDb: wasGain, volumeKeyframes: wasKeys, crossfadeMs: wasFade, ...wasRest } = was as unknown as Record<string, unknown>;
    const { duck: nowDuck, gainDb: nowGain, volumeKeyframes: nowKeys, crossfadeMs: nowFade, ...nowRest } = c as unknown as Record<string, unknown>;
    const changes = changedFields(wasRest, nowRest);
    // The B3 level fields read in words, not as raw JSON.
    if (!same(wasGain, nowGain)) changes.push(gainText(nowGain as number | undefined) || "gain off");
    if (!same(wasKeys, nowKeys)) changes.push(envelopeText(nowKeys as PersistedAudioClip["volumeKeyframes"]) || "envelope off");
    if (!same(wasFade, nowFade)) changes.push(crossfadeText(nowFade as number | undefined) || "crossfade off");
    if (!same(wasDuck, nowDuck)) {
      if (!wasDuck) changes.push(`duck on${duckText(nowDuck)}`);
      else if (!nowDuck) changes.push("duck off");
      else changes.push(...fieldChanges("duck", wasDuck, nowDuck));
    }
    if (changes.length) lines.push(`audio clip ${label(id)}: ${changes.join(", ")}`);
  }
  for (const id of beforeClips.keys()) if (!afterClips.has(id)) lines.push(`audio clip ${label(id)} removed`);

  if (lines.length > DIFF_LINE_CAP) {
    const more = lines.length - DIFF_LINE_CAP;
    return [...lines.slice(0, DIFF_LINE_CAP), `… and ${more} more change${more === 1 ? "" : "s"}`];
  }
  return lines;
}
