/**
 * Pure timeline track-label derivation. One place decides the text shown inside
 * an overlay's timeline bar so every surface agrees. NO React, NO DOM.
 *
 * Per-kind rules (from the WS4 spec):
 *  - text   → the actual text content (no kind prefix; capped).
 *  - code   → "code - <displayName>".
 *  - three  → "three - <displayName>".
 *  - image/video → the name (displayName ?? file name), capped to ~10 chars on a
 *    WORD boundary (a thumbnail is shown too, so the label stays short).
 *  - tracked → "tracked" (its content kind is incidental).
 *  - inline audio of a video → "audio of video - <name>" (see audioTrackLabel).
 */
import type { Overlay } from "@/lib/engine/types";

/** Longest a code/three/text label runs before a hard ellipsis. */
export const TRACK_LABEL_MAX = 24;
/** Image/video/audio names: up to 3 words and 20 chars (a thumbnail carries the
 *  rest of the identity), never cutting a word mid-way. */
export const MEDIA_NAME_MAX = 20;
/** Max words for a media (image/video/audio) name. */
export const MEDIA_NAME_MAX_WORDS = 3;

/** Hard char cap with an ellipsis (collapses internal whitespace first). */
export function capChars(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trimEnd() + "…";
}

/**
 * Cap to at most `max` chars AND at most `maxWords` words, WITHOUT splitting a
 * word: take whole words while they fit both limits; if the very first word
 * already exceeds `max` chars, hard-cap it. Appends an ellipsis whenever the
 * input was truncated.
 */
export function capWords(s: string, max: number, maxWords = Infinity): string {
  const t = s.replace(/\s+/g, " ").trim();
  const words = t.split(" ");
  if (t.length <= max && words.length <= maxWords) return t;
  let out = "";
  let count = 0;
  for (const w of words) {
    if (count >= maxWords) break;
    const next = out ? `${out} ${w}` : w;
    if (next.length > max) break;
    out = next;
    count++;
  }
  if (!out) out = t.slice(0, max).trimEnd(); // first word longer than the cap
  return `${out}…`;
}

/**
 * The label for an overlay's timeline bar. `fileName` is the source file's
 * display name (for image/video when no displayName is set).
 */
export function overlayTrackLabel(o: Overlay, fileName?: string): string {
  switch (o.kind) {
    case "text": {
      const text = capChars(o.content ?? "", TRACK_LABEL_MAX);
      return text || "text";
    }
    case "code":
      return `code - ${capChars(o.displayName ?? "", TRACK_LABEL_MAX) || "untitled"}`;
    case "three":
      return `three - ${capChars(o.displayName ?? "", TRACK_LABEL_MAX) || "untitled"}`;
    case "image":
    case "video":
      return capWords(o.displayName ?? fileName ?? o.kind, MEDIA_NAME_MAX, MEDIA_NAME_MAX_WORDS);
    case "tracked":
      return o.displayName ? capChars(o.displayName, TRACK_LABEL_MAX) : "tracked";
    default:
      return (o as Overlay).kind;
  }
}

/**
 * The FULL (uncapped) rail-icon tooltip for an overlay track: "<type> — <full
 * name>", plus an attached-audio note for videos. Shown on hover of the track's
 * icon so the user can read the whole name the bar label truncates.
 */
export function overlayTrackTooltip(o: Overlay, fileName?: string, hasCoupledAudio?: boolean): string {
  const full = (() => {
    switch (o.kind) {
      case "text":
        return (o.content ?? "").replace(/\s+/g, " ").trim() || "(empty)";
      case "code":
        return o.displayName?.trim() || "(unnamed)";
      case "three":
        return o.displayName?.trim() || "(unnamed)";
      case "image":
      case "video":
        return o.displayName?.trim() || fileName || o.kind;
      case "tracked":
        return o.displayName?.trim() || "tracked";
      default:
        return (o as Overlay).kind;
    }
  })();
  const kind = (o as Overlay).kind;
  let s = `${kind} — ${full}`;
  if (kind === "video") s += hasCoupledAudio ? " · audio attached" : " · no attached audio";
  return s;
}

/** The label for an INLINE audio clip that belongs to a video (scene or overlay):
 *  "audio of video - <name>". For a standalone clip, returns its own label/name. */
export function audioTrackLabel(args: {
  inline: boolean;
  /** The parent video's name (overlay displayName / file name) when inline. */
  videoName?: string;
  /** The clip's own label (standalone clips). */
  clipLabel?: string;
}): string {
  if (args.inline) {
    return `audio of video - ${capWords(args.videoName ?? "", MEDIA_NAME_MAX, MEDIA_NAME_MAX_WORDS) || "clip"}`;
  }
  return capChars(args.clipLabel ?? "audio", TRACK_LABEL_MAX);
}
