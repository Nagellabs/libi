/** One-click caption style presets. Each preset is a `Partial<TextOverlay>`
 *  the UI/agent merges onto a text overlay to apply a look. Pure data + a
 *  lookup helper — canvas-free, DOM-free. */
import type { TextOverlay } from "@/lib/engine/types";
import type { OverlayPreset } from "@/lib/overlays/presets";

export interface CaptionPreset {
  id: string;
  label: string;
  partial: Partial<TextOverlay>;
}

export const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: "clean",
    label: "Clean",
    partial: {
      color: "#ffffff",
      shadow: { color: "rgba(0,0,0,0.55)", blur: 8, dx: 0, dy: 2 },
    },
  },
  {
    id: "boxed",
    label: "Boxed",
    partial: {
      color: "#ffffff",
      background: { color: "rgba(0,0,0,0.6)", padding: 12, radius: 8 },
    },
  },
  {
    id: "outline",
    label: "Outline",
    partial: {
      color: "#ffffff",
      stroke: { color: "#000000", width: 6 },
    },
  },
  {
    id: "pop",
    label: "Pop",
    partial: {
      color: "#ffd400",
      stroke: { color: "#000000", width: 6 },
      reveal: { mode: "pop" },
    },
  },
  {
    id: "typed",
    label: "Typed",
    partial: {
      color: "#ffffff",
      stroke: { color: "#000000", width: 6 },
      reveal: { mode: "typewriter", fraction: 0.6 },
    },
  },
];

/** A preset patch — like `Partial<TextOverlay>` but the nullable style keys may
 *  be `null` to CLEAR a previously-set value (the optimistic patch path + the
 *  PATCH route both treat `null` as "delete this key"). */
export type CaptionPresetPatch = Partial<
  Omit<TextOverlay, "background" | "stroke" | "shadow" | "reveal">
> & {
  background?: TextOverlay["background"] | null;
  stroke?: TextOverlay["stroke"] | null;
  shadow?: TextOverlay["shadow"] | null;
  reveal?: TextOverlay["reveal"] | null;
};

/** The nullable style keys a preset may omit. Applying a preset emits `null` for
 *  each omitted one so switching presets clears the prior look (idempotent) —
 *  otherwise a stale `background`/`stroke` survives and `matchCaptionPreset`
 *  silently fails to mark the new chip active. */
export const NULLABLE_PRESET_KEYS = ["background", "stroke", "shadow", "reveal"] as const;

/**
 * Returns the patch to apply a preset for a known id (with omitted nullable
 * style keys explicitly set to `null` so application is idempotent), or `{}` for
 * an unknown id.
 */
export function applyCaptionPreset(id: string): CaptionPresetPatch {
  const preset = CAPTION_PRESETS.find((p) => p.id === id);
  if (!preset) return {};
  const partial = preset.partial as Record<string, unknown>;
  const patch: CaptionPresetPatch = { ...preset.partial };
  for (const key of NULLABLE_PRESET_KEYS) {
    if (partial[key] == null) {
      (patch as Record<string, unknown>)[key] = null;
    }
  }
  return patch;
}

/** The styling fields a preset may set. Used by `matchCaptionPreset` to detect
 *  both "every declared field matches" AND "no extra styling field is set that
 *  the preset omits" — so two presets sharing a key don't collide. */
const PRESET_STYLE_KEYS = ["color", "background", "stroke", "shadow", "reveal"] as const;

/**
 * Returns the id of the preset whose styling fields all equal the overlay's
 * current values, or `null` if none match. A preset matches when every key it
 * declares deep-equals the overlay's value AND the overlay sets no styling key
 * the preset omits (so an outline+stroke overlay doesn't match the color-only
 * look of a different preset). Pure — no DOM, no canvas.
 */
export function matchCaptionPreset(overlay: Partial<TextOverlay>): string | null {
  for (const preset of CAPTION_PRESETS) {
    const partial = preset.partial as Record<string, unknown>;
    const o = overlay as Record<string, unknown>;
    const allKeysAgree = PRESET_STYLE_KEYS.every((key) => {
      // Treat null AND undefined as "not set" — applying a preset clears omitted
      // nullable keys to null, which must read as absent here.
      const presetHas = partial[key] != null;
      const overlayHas = o[key] != null;
      if (presetHas !== overlayHas) return false;
      if (!presetHas) return true;
      return deepEqual(partial[key], o[key]);
    });
    if (allKeysAgree) return preset.id;
  }
  return null;
}

/** Structural deep-equality for the small plain-object/primitive preset values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** The bundled style presets re-expressed as kind:"text" OverlayPresets, so they
 *  merge into the unified preset system (user presets shadow these by id). */
export const BUNDLED_OVERLAY_PRESETS: OverlayPreset[] = CAPTION_PRESETS.map((p) => ({
  id: p.id,
  name: p.label,
  kind: "text",
  source: "bundled",
  fields: { ...p.partial } as Record<string, unknown>,
}));
