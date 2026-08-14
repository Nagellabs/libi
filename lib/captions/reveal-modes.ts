// lib/captions/reveal-modes.ts
import type { CaptionRevealMode } from "@/lib/engine/types";

/** A tunable parameter a reveal mode exposes in the Reveal family panel. */
export type RevealParam =
  | { key: "highlightColor"; label: string; type: "color"; default: string }
  | {
      key: "direction";
      label: string;
      type: "enum";
      options: { value: string; label: string }[];
      default: string;
    }
  | { key: "sideOffset"; label: string; type: "number"; min: number; max: number; step: number; default: number };

/** Where a reveal mode can render: 2D captions only, 3D captions only, or both. */
export type RevealDimSupport = "2d" | "3d" | "any";

export interface RevealModeDef {
  /** The value written to `overlay.reveal.mode` (or null clears reveal). */
  mode: Exclude<CaptionRevealMode, "pop">;
  label: string;
  /** Short hint shown under the card. */
  hint: string;
  /** Render-dimension support — drives enable/disable when the caption is 3D. */
  dim: RevealDimSupport;
  /** Inline params surfaced when this mode is the selected reveal. */
  params: RevealParam[];
}

/**
 * The Reveal family catalog — the single source of the text reveal modes shown
 * in the Effects panel's Reveal tab (single-select over `overlay.reveal.mode`).
 *
 * NOTE: `pop` is intentionally absent — it's a box-scale **Animation** effect,
 * not a word-level reveal. `flythrough` (Paint-on) is 3D-only; the rest are 2D.
 */
export const REVEAL_MODES: RevealModeDef[] = [
  { mode: "none", label: "None", hint: "No reveal — the caption is shown all at once.", dim: "any", params: [] },
  { mode: "typewriter", label: "Typewriter", hint: "Characters appear one by one.", dim: "2d", params: [] },
  { mode: "fade-words", label: "Fade words", hint: "Each word fades in in sequence.", dim: "2d", params: [] },
  { mode: "slide-up", label: "Slide up", hint: "Lines slide up as they appear.", dim: "2d", params: [] },
  {
    mode: "karaoke",
    label: "Karaoke",
    hint: "Full line shown; the active word is highlighted in sync.",
    dim: "2d",
    params: [{ key: "highlightColor", label: "Highlight", type: "color", default: "#ffd700" }],
  },
  { mode: "word-current", label: "Word (current)", hint: "Only the active word is shown, swapped over time.", dim: "2d", params: [] },
  {
    mode: "flythrough",
    label: "Paint-on (3D)",
    hint: "3D camera flies along extruded glyphs, writing each one.",
    dim: "3d",
    params: [
      {
        key: "direction",
        label: "Direction",
        type: "enum",
        options: [
          { value: "ltr", label: "Left → right" },
          { value: "rtl", label: "Right → left" },
          { value: "through", label: "Through the wall" },
        ],
        default: "ltr",
      },
      { key: "sideOffset", label: "Angle", type: "number", min: 0.3, max: 3, step: 0.05, default: 1.05 },
    ],
  },
];

/** Is `mode` enabled for a caption whose 3D state is `isThreeD`? `none` is
 *  always enabled; a `2d` mode is disabled on a 3D caption and vice-versa. */
export function isRevealModeEnabled(def: RevealModeDef, isThreeD: boolean): boolean {
  if (def.dim === "any") return true;
  return isThreeD ? def.dim === "3d" : def.dim === "2d";
}

/** Why a reveal mode is unavailable for the caption's current 3D state, or null
 *  when it IS available. Shown as a tooltip on the disabled card. */
export function revealDisabledReason(def: RevealModeDef, isThreeD: boolean): string | null {
  if (isRevealModeEnabled(def, isThreeD)) return null;
  return def.dim === "3d"
    ? "Make the caption 3D (Text tab → “Make text 3D”) to use this reveal."
    : "Not available on a 3D caption — turn off 3D to use this reveal.";
}

/** The catalog split into the always-on/2D modes and the 3D-only modes, for the
 *  panel's two sections. */
export function partitionRevealModes(): { flat: RevealModeDef[]; spatial: RevealModeDef[] } {
  return {
    flat: REVEAL_MODES.filter((m) => m.dim !== "3d"),
    spatial: REVEAL_MODES.filter((m) => m.dim === "3d"),
  };
}
