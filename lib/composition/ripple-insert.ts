/**
 * Open a hole in the timeline: the inverse of `rippleCloseGap` (./ripple.ts). Insert `seconds` of time at
 * composition time `at`, and move everything that belongs after it.
 *
 *   - STARTS at or after `at`           -> SHIFTED right by `seconds` (every overlay and audio clip, the same
 *                                          timeline-wide rule `rippleCloseGap` uses: no lanes, no sync lock).
 *   - SPANS `at` (starts before it, ends after it) -> LEFT where it is, unless it STRETCHES. The default
 *                                          stretches the FULL-LENGTH layers: a layer that starts at or before
 *                                          `at` and runs to the end of its family's timeline (overlays against
 *                                          the last overlay end, audio clips against the last audio end).
 *                                          That is a background, a bed or a whole-piece code layer, which must
 *                                          keep covering the piece. A caption, a sticker or a narration that
 *                                          merely straddles `at` is left.
 *   - ENDS at or before `at`            -> untouched.
 *   - `extendTarget`                    -> one overlay LENGTHENED by `seconds` at its end (the intro that
 *                                          must run 3 s longer). A video also extends its source `trim`, and
 *                                          needs the room in its file: no room is an error, not a freeze.
 *
 * The piece's length is derived from its contents (./duration.ts), so "extend the piece" needs no write.
 *
 * What rides along, and what deliberately does not:
 *   - An inline audio clip FOLLOWS its video overlay: shifted with it, stretched or extended by the same
 *     amount. Detached and standalone clips are ordinary clips.
 *   - Overlay keyframes are normalised 0..1 inside the overlay's window, so a SHIFTED overlay keeps them
 *     exactly and a STRETCHED or EXTENDED one keeps them RELATIVE (a Ken Burns still spans the whole layer).
 *   - Caption words (`caption.words`) are overlay-local seconds: they move with their overlay, untouched.
 *   - A clip's volume envelope (`volumeKeyframes`) is clip-local seconds. A shifted clip keeps it as is.
 *     A stretched or extended clip moves the keys that sit at or after `at` by `seconds`, so a dip made
 *     for the narration that moved still lines up with it.
 *   - Duck relationships and audio-clip / overlay links are ids, which never change.
 *   - There are no markers, and storyboard cards carry no timeline position (placing a card re-flows
 *     storyboard-owned overlays back to back from 0), so nothing else holds a time.
 *
 * Pure: no IO, no manifest save. A refusal changes nothing.
 */
import type { CompositionManifest, PersistedAudioClip, PersistedOverlay } from "./persistence";
import { pieceDurationSec } from "./duration";
import { crossfadePlan } from "@/lib/audio/clip-gain";

/** Float noise is not a boundary: starts within this of `at` count as at it. */
const EPS = 1e-6;
/** A layer ending within this of its family's last end still reaches "the end" (one frame at 30 fps). */
const FULL_LENGTH_TOL = 0.05;
/** A source may fall this short of what a stretch asks for (container rounding) and still count as room. */
const ROOM_TOL = 0.05;
/** An extend target may end this far before `at` and still count as ending there. */
const EXTEND_END_TOL = 0.05;

export type StretchOption = readonly string[] | "spanning" | "none";

export interface InsertTimeOptions {
  /** Composition seconds where the time is inserted. */
  at: number;
  /** How much time to insert (> 0). */
  seconds: number;
  /** Absent: stretch the full-length layers that span `at`. "spanning": every layer that spans it.
   *  "none": none. A list of ids: exactly those. */
  stretch?: StretchOption;
  /** An overlay to lengthen by `seconds` (its trim extends too). */
  extendTarget?: string;
  /** The media length in seconds of a file, or null/undefined when unknown. */
  mediaDuration?: (fileId: string) => number | null | undefined;
}

export type InsertTimeError =
  | "invalid_seconds"
  | "invalid_at"
  | "stretch_id_not_found"
  | "stretch_id_not_spanning"
  | "extend_target_not_found"
  | "extend_target_not_overlay"
  | "extend_target_not_at_end"
  | "no_source_room";

export interface InsertTimeReport {
  at: number;
  seconds: number;
  pieceDuration: { before: number; after: number };
  /** Ids (overlays and audio clips) moved right by `seconds`. */
  shifted: string[];
  /** Ids lengthened because they spanned `at`. */
  stretched: string[];
  /** Overlays lengthened on request, with the window before and after. */
  extended: { id: string; duration: [number, number]; trim?: [[number, number], [number, number]] }[];
  /** Ids that span `at` and were left alone. */
  leftSpanning: string[];
  warnings: string[];
}

export type InsertTimeResult =
  | { ok: true; manifest: CompositionManifest; report: InsertTimeReport }
  | { ok: false; error: InsertTimeError; message: string };

type Action = "shift" | "stretch" | "extend";

const round = (n: number): number => Math.round(n * 1000) / 1000;
const fmt = (n: number): string => String(Math.round(n * 100) / 100);

/** Seconds of the source left after a layer's current window, or null when its length is unknown. */
export function sourceRoom(srcDuration: number | null | undefined, trimStart: number, duration: number): number | null {
  if (typeof srcDuration !== "number" || !Number.isFinite(srcDuration) || srcDuration <= 0) return null;
  return srcDuration - (trimStart + duration);
}

/** Move a clip's volume-envelope keys that sit at or after composition time `at` by `seconds`. */
function shiftEnvelopeKeys(clip: PersistedAudioClip, at: number, seconds: number): PersistedAudioClip {
  const keys = clip.volumeKeyframes?.keyframes;
  if (!keys || keys.length === 0) return clip;
  const localAt = at - clip.startTime;
  return {
    ...clip,
    volumeKeyframes: { keyframes: keys.map((k) => (k.t >= localAt - EPS ? { ...k, t: k.t + seconds } : k)) },
  };
}

export function rippleInsertTime(m: CompositionManifest, opts: InsertTimeOptions): InsertTimeResult {
  const { at, seconds } = opts;
  if (!(seconds > 0) || !Number.isFinite(seconds)) {
    return { ok: false, error: "invalid_seconds", message: "`seconds` must be a positive number: it is the time to insert." };
  }
  if (!(at >= 0) || !Number.isFinite(at)) {
    return { ok: false, error: "invalid_at", message: "`at` must be a time in seconds, 0 or later." };
  }
  const overlays = m.overlays ?? [];
  const clips = m.audioClips ?? [];
  const end = (i: { startTime: number; duration: number }): number => i.startTime + i.duration;
  const spans = (i: { startTime: number; duration: number }): boolean => i.startTime < at - EPS && end(i) > at + EPS;
  const overlayById = new Map(overlays.map((o) => [o.id, o]));
  const isCoupled = (c: PersistedAudioClip): boolean =>
    c.kind === "inline" && !!c.linkedOverlayId && overlayById.has(c.linkedOverlayId);

  // ── validate the explicit asks first, so a refusal changes nothing ────────────────────────────────────────
  let stretchIds: Set<string> | null = null;
  if (Array.isArray(opts.stretch)) {
    stretchIds = new Set();
    for (const id of opts.stretch as string[]) {
      const overlay = overlayById.get(id);
      const clip = clips.find((c) => c.id === id);
      const item = overlay ?? clip;
      if (!item) {
        return { ok: false, error: "stretch_id_not_found", message: `stretch: no overlay or audio clip with id ${id} on this piece.` };
      }
      if (end(item) <= at + EPS) {
        return {
          ok: false,
          error: "stretch_id_not_spanning",
          message:
            `stretch: ${id} ends at ${fmt(end(item))} s, before at=${fmt(at)}, so there is nothing to stretch. ` +
            `To lengthen a clip that ends where the time goes in, pass it as \`extendTarget\`.`,
        };
      }
      // A coupled inline clip is stretched through its video.
      stretchIds.add(!overlay && clip && isCoupled(clip) ? clip.linkedOverlayId! : id);
    }
  }
  const target = opts.extendTarget !== undefined ? overlayById.get(opts.extendTarget) : undefined;
  if (opts.extendTarget !== undefined) {
    if (!target) {
      const isClip = clips.some((c) => c.id === opts.extendTarget);
      return {
        ok: false,
        error: isClip ? "extend_target_not_overlay" : "extend_target_not_found",
        message: isClip
          ? `extendTarget ${opts.extendTarget} is an audio clip: pass the overlay (a video overlay's inline audio extends with it).`
          : `extendTarget: no overlay with id ${opts.extendTarget} on this piece.`,
      };
    }
    if (target.startTime >= at - EPS || end(target) < at - EXTEND_END_TOL) {
      return {
        ok: false,
        error: "extend_target_not_at_end",
        message:
          `extendTarget ${target.id} runs ${fmt(target.startTime)}–${fmt(end(target))} s: it must start before at=${fmt(at)} ` +
          `and end where the time is inserted (at ${fmt(at)}) or later. Set \`at\` to its end (${fmt(end(target))}) to lengthen it.`,
      };
    }
  }

  // ── classify the overlays ────────────────────────────────────────────────────────────────────────────────────
  const lastOverlayEnd = overlays.reduce((mx, o) => Math.max(mx, end(o)), 0);
  const lastAudioEnd = clips.reduce((mx, c) => Math.max(mx, end(c)), 0);
  const explicitStretch = stretchIds !== null;
  const wantsStretch = (id: string, finish: number, lastEnd: number): boolean => {
    if (stretchIds) return stretchIds.has(id);
    if (opts.stretch === "spanning") return true;
    if (opts.stretch === "none") return false;
    return finish >= lastEnd - FULL_LENGTH_TOL;
  };

  const shifted: string[] = [];
  const stretched: string[] = [];
  const extended: InsertTimeReport["extended"] = [];
  const leftSpanning: string[] = [];
  const warnings: string[] = [];
  /** overlay id -> what happened to it and how many seconds it gained (a stretch can be capped by its source). */
  const outcome = new Map<string, { action: Action; by: number }>();

  const nextOverlays: PersistedOverlay[] = [];
  for (const o of overlays) {
    let action: Action | null = null;
    if (target && o.id === target.id) action = "extend";
    else if (o.startTime >= at - EPS) action = "shift";
    else if (spans(o)) {
      if (wantsStretch(o.id, end(o), lastOverlayEnd)) action = "stretch";
      else leftSpanning.push(o.id);
    }
    if (!action) {
      nextOverlays.push(o);
      continue;
    }
    if (action === "shift") {
      nextOverlays.push({ ...o, startTime: o.startTime + seconds } as PersistedOverlay);
      outcome.set(o.id, { action, by: seconds });
      shifted.push(o.id);
      continue;
    }

    // stretch / extend: lengthen at the end. A video can only play what its file has.
    let by = seconds;
    let trim = o.kind === "video" ? o.trim : undefined;
    if (o.kind === "video") {
      const room = sourceRoom(opts.mediaDuration?.(o.fileId), o.trim?.start ?? 0, o.duration);
      if (room === null) {
        warnings.push(`${o.id}: the source length is unknown, so it was lengthened without checking the file has the footage.`);
      } else if (room < seconds - ROOM_TOL) {
        if (action === "extend" || explicitStretch) {
          const have = Math.max(0, room);
          return {
            ok: false,
            error: "no_source_room",
            message:
              `${o.id} plays ${fmt(o.trim?.start ?? 0)}–${fmt((o.trim?.start ?? 0) + o.duration)} s of a ${fmt(opts.mediaDuration!(o.fileId)!)} s file: ` +
              `only ${fmt(have)} s of footage is left, so it cannot run ${fmt(seconds)} s longer. ` +
              `Insert at most ${fmt(have)} s, or put a longer take on it first.`,
          };
        }
        by = Math.max(0, room);
        warnings.push(
          `${o.id}: its source has only ${fmt(Math.max(0, room))} s of footage left, so it was lengthened by ${fmt(by)} s, not ${fmt(seconds)} s.`,
        );
      }
      if (trim) trim = { start: trim.start, end: trim.start + o.duration + by };
    }
    const next = { ...o, duration: o.duration + by, ...(trim ? { trim } : {}) } as PersistedOverlay;
    nextOverlays.push(next);
    outcome.set(o.id, { action, by });
    if (action === "extend") {
      extended.push({
        id: o.id,
        duration: [round(o.duration), round(next.duration)],
        ...(o.kind === "video" && o.trim && trim
          ? { trim: [[round(o.trim.start), round(o.trim.end)], [round(trim.start), round(trim.end)]] as [[number, number], [number, number]] }
          : {}),
      });
    } else if (by > 0) stretched.push(o.id);
  }

  // ── audio clips ──────────────────────────────────────────────────────────────────────────────────────────────
  const nextClips: PersistedAudioClip[] = [];
  for (const c of clips) {
    const linked = isCoupled(c) ? outcome.get(c.linkedOverlayId!) : undefined;
    const coupledLeft = isCoupled(c) && !linked;
    let action: Action | null = null;
    let by = seconds;
    if (linked) {
      action = linked.action;
      by = linked.by;
    } else if (!coupledLeft) {
      if (c.startTime >= at - EPS) action = "shift";
      else if (spans(c) && wantsStretch(c.id, end(c), lastAudioEnd)) action = "stretch";
      else if (spans(c)) leftSpanning.push(c.id);
    }
    if (coupledLeft) {
      // Follows a video the insert did not touch (it is listed with the video, if that spans `at`).
      nextClips.push(c);
      continue;
    }
    if (!action) {
      nextClips.push(c);
      continue;
    }
    if (action === "shift") {
      nextClips.push({ ...c, startTime: c.startTime + seconds });
      shifted.push(c.id);
      continue;
    }

    // stretch / extend an audio clip: it plays on into more of its file, capped by what the file has.
    if (!linked) {
      const room = sourceRoom(opts.mediaDuration?.(c.fileId), c.trimStart, c.duration);
      if (room !== null && room < seconds - ROOM_TOL) {
        by = Math.max(0, room);
        warnings.push(
          `${c.id}: its file has only ${fmt(Math.max(0, room))} s left after the clip, so it was lengthened by ${fmt(by)} s, not ${fmt(seconds)} s.`,
        );
      }
    }
    // The envelope keys at/after `at` ride with the inserted time, even when the clip itself gained less.
    nextClips.push(shiftEnvelopeKeys({ ...c, duration: c.duration + by }, at, seconds));
    if (!linked || linked.action === "stretch") {
      if (by > 0) stretched.push(c.id);
    }
  }

  const manifest: CompositionManifest = { ...m, overlays: nextOverlays, audioClips: nextClips };

  // A crossfade needs the clip before it to overlap it. Moving one half and not the other loses it.
  const before = crossfadePlan(clips.map((c) => ({ ...c })));
  const after = crossfadePlan(nextClips.map((c) => ({ ...c })));
  for (const id of before.keys()) {
    if (before.get(id)?.in && !after.get(id)?.in) {
      warnings.push(`${id}: its crossfade no longer overlaps the clip it spliced onto (one moved, the other did not).`);
    }
  }

  return {
    ok: true,
    manifest,
    report: {
      at: round(at),
      seconds: round(seconds),
      pieceDuration: { before: round(pieceDurationSec(m)), after: round(pieceDurationSec(manifest)) },
      shifted,
      stretched,
      extended,
      leftSpanning,
      warnings,
    },
  };
}
