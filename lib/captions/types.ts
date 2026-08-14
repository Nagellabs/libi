// lib/captions/types.ts
import type { CaptionReveal, CaptionStroke, CaptionShadow, CaptionBackground } from "@/lib/engine/types";

/** One spoken word with its ELEMENT-LOCAL timing (seconds relative to the cue
 *  overlay's `startTime`). Carries the real STT per-word times through to the
 *  renderer so time-synced reveals (karaoke / word-current / fade-words)
 *  emphasize the word that is ACTUALLY being spoken, instead of a linear
 *  even-spacing guess across the cue window. */
export interface CaptionCueWord {
  text: string;
  start: number;
  end: number;
}

/** Per-cue membership in a caption track. Stored on the TextOverlay as `caption`. */
export interface CaptionGroupRef {
  /** All cues sharing this id form one track. */
  groupId: string;
  /** Id of the style (bundled or user) the group applies. */
  styleRef?: string;
  /** When true (default) the cue inherits the group's styleRef and shared edits.
   *  Editing a cue with scope "cue" sets this false (detaches it). */
  useTrackStyle: boolean;
  /** Real per-word timings (element-local seconds) for accurate time-synced
   *  reveals. Absent ⇒ the renderer falls back to linear even-spacing. */
  words?: CaptionCueWord[];
}

/** 3×3 numpad anchor (ASS `\an`). 7 8 9 / 4 5 6 / 1 2 3 (top row = 7/8/9). */
export type CaptionAnchor =
  | "top-left" | "top-center" | "top-right"
  | "mid-left" | "mid-center" | "mid-right"
  | "bottom-left" | "bottom-center" | "bottom-right";

export type Caption3DLook = "flat" | "billboard" | "lay-on-road" | "low-angle" | "angled";

/** The reusable style payload (look + reveal). Mirrors the TextOverlay styling subset. */
export interface CaptionStyle {
  id: string;
  label: string;
  source: "bundled" | "user";
  color: string;
  highlightColor?: string;
  stroke?: CaptionStroke | null;
  shadow?: CaptionShadow | null;
  background?: CaptionBackground | null;
  reveal?: CaptionReveal | null;
  fontFamily?: string;
  fontWeight?: number | string;
}

/** A timed caption line built from word timings. */
export interface CaptionCue {
  text: string;
  start: number; // absolute seconds
  end: number;
  /** The cue's spoken words with ABSOLUTE start/end seconds (from STT). */
  words?: CaptionCueWord[];
}
