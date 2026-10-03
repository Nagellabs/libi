/**
 * Per-layer overrides on a template apply (`libi.apply_template`'s `layerOverrides`).
 *
 * `{ "<layer key>": { …overlay fields } }`: the same fields `libi.update_overlay` takes (its schema,
 * minus the ids and what only another tool may set, validates the shape in `mcp/tools/schemas.ts`),
 * applied to the layer as it is placed, so a restyle costs no extra call. This module is the part that
 * needs to know the layer's KIND: a text-only field on an image layer is refused up front, not
 * dropped. A `null` clears a field, as it does on `update_overlay`.
 */
import type { Transform3D } from "@/lib/engine/types";
import { IDENTITY_TRANSFORM3D } from "@/lib/overlays/transform3d";
import { rotationDegToTransform } from "@/lib/overlays/keyframes";

/** Fields only a text layer has. */
const TEXT_ONLY = [
  "content", "font", "color", "align", "fontFamily", "fontSize", "fontWeight", "lineHeight",
  "background", "stroke", "shadow", "reveal", "threeD", "position", "maxWidthPct",
] as const;
const VIDEO_ONLY = ["fit"] as const;
const THREE_ONLY = ["cameraPreset"] as const;

/** The reason an override names a field its layer's kind does not have, or null. */
export function overrideKindProblem(kind: string, override: Record<string, unknown>): string | null {
  const wrong: string[] = [];
  for (const key of Object.keys(override)) {
    if ((TEXT_ONLY as readonly string[]).includes(key) && kind !== "text") wrong.push(`${key} (text layers only)`);
    else if ((VIDEO_ONLY as readonly string[]).includes(key) && kind !== "video") wrong.push(`${key} (video layers only)`);
    else if ((THREE_ONLY as readonly string[]).includes(key) && kind !== "three") wrong.push(`${key} (three layers only)`);
  }
  return wrong.length > 0 ? `a ${kind} layer has no ${wrong.join(", ")}` : null;
}

/**
 * Write `override` onto `layer` (a placed overlay's fields), except `rect`: the caller places a rect so
 * the layer's keyframes and text position can follow it. `rotation` is degrees, folded into
 * `transform3d` as `update_overlay` does; `null` deletes a field.
 */
export function applyOverrideFields(layer: Record<string, unknown>, override: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || key === "rect") continue;
    if (key === "rotation") continue;
    if (value === null) delete layer[key];
    else layer[key] = value;
  }
  if (typeof override.rotation === "number") {
    const base = (layer.transform3d as Transform3D | undefined) ?? IDENTITY_TRANSFORM3D;
    layer.transform3d = rotationDegToTransform(base, override.rotation % 360);
  }
}
