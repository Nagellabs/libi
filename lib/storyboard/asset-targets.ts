import type { StoryboardCard } from "./types";
import type { ModelSchema } from "./gen-schema";
import { referenceTargets, type ReferenceFamily } from "./reference-targets";

export type AssetTargetKind = "keyframe" | "sketch" | "reference";
export type AssetTargetGroup = "Keyframes" | "Sketches" | "References";

export type AssetTarget = {
  /** Stable unique id for React keys + selection. */
  id: string;
  kind: AssetTargetKind;
  family: ReferenceFamily;
  label: string;
  group: AssetTargetGroup;
  /** Clip-gen param this target sets (keyframe + reference). */
  paramKey?: string;
  /** Sketch slot this target belongs to (keyframe + sketch). */
  slotId?: string;
  /** Whether the target already carries a value. */
  filled: boolean;
  /** Reference videos can also live-link another scene's take. */
  supportsInherit?: boolean;
};

const ROLE_FRAME: Record<string, string> = {
  start: "Start frame",
  end: "End frame",
  reference: "Reference frame",
};
const ROLE_SKETCH: Record<string, string> = {
  start: "Start sketch",
  end: "End sketch",
  reference: "Reference sketch",
};

/** Pure: everything the card's Add/import menu can set — per-slot KEYFRAMES (the
 *  realized image at each sketch slot's paramKey), per-slot SKETCHES (an imported
 *  image used AS the sketch), and schema-derived REFERENCES (excluding the keyframe
 *  params). Returning only model-backed targets keeps imports honest (no binding to
 *  a param the model lacks). */
export function cardAssetTargets(card: StoryboardCard, schema: ModelSchema | undefined): AssetTarget[] {
  const params = card.clipGen?.params ?? {};
  const out: AssetTarget[] = [];

  for (const s of card.sketches) {
    const v = params[s.paramKey];
    out.push({
      id: `kf:${s.id}`,
      kind: "keyframe",
      family: "image",
      group: "Keyframes",
      label: ROLE_FRAME[s.role] ?? "Keyframe",
      paramKey: s.paramKey,
      slotId: s.id,
      filled: typeof v === "string" ? v.length > 0 : false,
    });
  }

  for (const s of card.sketches) {
    out.push({
      id: `sk:${s.id}`,
      kind: "sketch",
      family: "image",
      group: "Sketches",
      label: ROLE_SKETCH[s.role] ?? "Sketch",
      slotId: s.id,
      filled: !!s.imageFileId,
    });
  }

  const refs = referenceTargets(schema, params, card.sketches.map((s) => s.paramKey));
  for (const r of refs) {
    out.push({
      id: `ref:${r.key}`,
      kind: "reference",
      family: r.family,
      group: "References",
      label: r.label,
      paramKey: r.key,
      filled: r.filled,
      supportsInherit: r.family === "video",
    });
  }

  return out;
}
