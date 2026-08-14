/** Shared params for the text-animation template library.
 *  Every template bakes these into a draw-fn body string (via JSON.stringify)
 *  and returns the body — which flows through the existing
 *  add_overlay (kind "code") → validateDrawFunction → createDrawFunction path. */

export type Align = "left" | "center" | "right";

export interface TextStyleParams {
  text: string;
  /** CSS font shorthand, e.g. "bold 64px Inter, sans-serif". */
  font?: string;
  /** CSS color. */
  color?: string;
  align?: Align;
}

export interface RevealParams extends TextStyleParams {
  /** Fraction of the overlay window spent revealing vs. holding. 0..1. */
  revealFraction?: number;
}

/** A single caption cue: text shown for [start, end) seconds (element-local). */
export interface CaptionCue {
  text: string;
  start: number;
  end: number;
}

export interface CaptionParams {
  cues: CaptionCue[];
  font?: string;
  color?: string;
  /** Stroke/plate color for contrast against video. */
  stroke?: string;
  align?: Align;
  /** Highlight the active word in a chunk (karaoke). Default false. */
  karaoke?: boolean;
  karaokeColor?: string;
}

/** A single spoken word with its element-local timing (seconds, relative to
 *  the caption overlay's startTime). `end` is optional — the word-driven
 *  caption styles key off `start` (each word stays/advances by start order),
 *  so a transcript that only exposes start times still works. */
export interface CaptionWord {
  text: string;
  start: number;
  end?: number;
}

/** Params for the word-timing-driven caption styles (cumulative / word-by-word
 *  / karaoke). The `words[]` come straight from the STT word array
 *  (analysis_get_audio_chunks), converted to element-local seconds. */
export interface WordCaptionParams {
  words: CaptionWord[];
  font?: string;
  color?: string;
  /** Stroke color for contrast against video. */
  stroke?: string;
  align?: Align;
  /** Karaoke active-word highlight color (captionKaraoke only). */
  highlightColor?: string;
}
