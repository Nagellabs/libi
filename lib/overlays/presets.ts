import type { Overlay } from "@/lib/engine/types";

/** Per-instance overlay keys NEVER captured by a preset (they define WHICH/WHERE,
 *  not the look). */
export const PRESET_EXCLUDED_KEYS = [
  "id", "kind", "content", "rect", "startTime", "duration", "fileId", "z",
  "trackId", "trackContent", "drawFunction", "sceneFunction", "group",
  // caption-track membership (CaptionGroupRef) — which group+style an overlay belongs to.
  // This is pure instance context, not look. A reusable style must NEVER carry it.
  "caption",
] as const;

export interface OverlayPreset {
  id: string;
  name: string;
  kind: Overlay["kind"];
  fields: Record<string, unknown>;
  source: "bundled" | "user";
  createdAt?: string;
  /** ISO last-save time (set on every write; preserved-createdAt on override). */
  updatedAt?: string;
}

const EXCLUDED = new Set<string>(PRESET_EXCLUDED_KEYS);

/** Capture an overlay's reusable styling/animation/transform fields (drops the
 *  excluded per-instance keys). Returns a plain JSON object. */
export function extractPresetFields(overlay: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(overlay)) {
    if (EXCLUDED.has(k)) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/** The merge patch to apply a preset onto a target overlay. */
export function applyPresetPatch(preset: OverlayPreset): Record<string, unknown> {
  return { ...preset.fields };
}

/** Order-insensitive deep stringify: recursively sorts object keys so two
 *  structurally-equal values produce an identical string regardless of key
 *  insertion order. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((v as Record<string, unknown>)[k])).join(",") + "}";
}

/** The id of the (same-kind) preset that best matches the overlay, or null. A
 *  preset is a candidate when every field it pins deep-equals the overlay's
 *  value for that key (the overlay may carry extra fields the preset doesn't
 *  pin); deep-equality is order-insensitive. Among candidates the MOST SPECIFIC
 *  wins — the one pinning the most fields (earlier presets break ties) — so a
 *  sparse preset (e.g. "clean" pinning only color) can't shadow a richer one
 *  ("boxed" pinning color + background) when both are subsets of the overlay.
 *  An empty-fields preset never matches (it would otherwise match everything). */
export function matchPreset(
  overlay: Record<string, unknown> & { kind: string },
  presets: OverlayPreset[],
): string | null {
  const captured = extractPresetFields(overlay);
  let bestId: string | null = null;
  let bestSpecificity = 0;
  for (const p of presets) {
    if (p.kind !== overlay.kind) continue;
    const entries = Object.entries(p.fields);
    if (entries.length === 0) continue;
    let ok = true;
    for (const [k, want] of entries) {
      if (stableStringify(captured[k]) !== stableStringify(want)) {
        ok = false;
        break;
      }
    }
    if (ok && entries.length > bestSpecificity) {
      bestId = p.id;
      bestSpecificity = entries.length;
    }
  }
  return bestId;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,48}$/;
export function isValidPresetSlug(s: string): boolean {
  return SLUG.test(s);
}
