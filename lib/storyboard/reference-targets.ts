import type { ModelSchema } from "./gen-schema";
import { catalogEntry } from "./param-catalog";

export type ReferenceFamily = "image" | "video" | "audio";

export type ReferenceTarget = {
  /** The clip-gen param this reference fills (e.g. reference_video, audio_ref). */
  key: string;
  family: ReferenceFamily;
  label: string;
  /** True when this param already carries a value in the card's clip spec. */
  filled: boolean;
};

/** Pure: the reference inputs a clip model actually supports, derived from its
 *  cached schema — every media-type field EXCEPT the keyframe params (those are
 *  conditioning frames, not references). Keyframes are excluded two ways: by the
 *  catalog (start_frame/end_frame) AND by `keyframeKeys` — the card's sketch-slot
 *  paramKeys, which carry the model's REAL keyframe param names (e.g. Seedance's
 *  image_url/end_image_url, Kling's tail_image_url) that the catalog can't know.
 *  Returning only schema-backed, non-keyframe targets means the unified
 *  "Add reference" UI can never bind to a param the model doesn't have, nor to a
 *  keyframe slot (the Finding-A/D class of mistake). */
export function referenceTargets(
  schema: ModelSchema | undefined,
  params: Record<string, unknown> = {},
  keyframeKeys: string[] = [],
): ReferenceTarget[] {
  if (!schema) return [];
  const excluded = new Set(keyframeKeys);
  const out: ReferenceTarget[] = [];
  for (const f of schema.fields) {
    if (f.type !== "image" && f.type !== "video" && f.type !== "audio") continue;
    if (excluded.has(f.key)) continue; // bound to a sketch slot = a keyframe, not a reference
    const cat = catalogEntry(f.key);
    if (cat?.group === "Keyframing") continue; // start_frame / end_frame are not references
    const v = params[f.key];
    out.push({
      key: f.key,
      family: f.type,
      label: cat?.label ?? f.key,
      filled: typeof v === "string" ? v.length > 0 : Array.isArray(v) ? v.length > 0 : v != null,
    });
  }
  return out;
}
