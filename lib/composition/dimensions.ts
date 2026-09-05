import { loadManifest, saveManifest } from "@/lib/composition/persistence";
import { navigationEmitter } from "@/lib/navigation-events";

export interface SetDimensionsResult {
  width: number;
  height: number;
  previousWidth: number;
  previousHeight: number;
  /** One entry per overlay whose rect no longer fits. Never a rejection —
   *  a resize that strands overlays is legal, the agent just has to know. */
  warnings: string[];
}

/**
 * The single write path for a piece's canvas dimensions.
 *
 * Both `libi.update_composition_dimensions` (agent) and
 * `PATCH /api/pieces/:id/composition/dimensions` (the empty-piece UI path)
 * call this. Two implementations of the same write would drift — most likely
 * in the out-of-bounds warnings, which is exactly the part the agent relies
 * on to know what it still has to fix.
 */
export async function setCompositionDimensions(
  pieceId: string,
  width: number,
  height: number,
): Promise<SetDimensionsResult> {
  if (!(width > 0) || !(height > 0)) {
    throw new Error("width and height must be positive");
  }

  const manifest = await loadManifest(pieceId);
  const previousWidth = manifest.width;
  const previousHeight = manifest.height;
  manifest.width = width;
  manifest.height = height;

  const warnings: string[] = [];
  for (const o of manifest.overlays ?? []) {
    const rect = o.rect;
    if (!rect) {
      // A corrupt overlay must not throw and abort an otherwise valid
      // resize, but silently dropping it defeats the point of this list —
      // the agent needs to know it still has to look at this overlay.
      warnings.push(`Overlay ${o.id} (${o.kind}) has no rect and was not checked against the new bounds.`);
      continue;
    }
    if (
      rect.x < 0 ||
      rect.y < 0 ||
      rect.x + rect.width > width ||
      rect.y + rect.height > height
    ) {
      warnings.push(
        `Overlay ${o.id} (${o.kind}) rect ${JSON.stringify(rect)} extends beyond new ${width}×${height} bounds.`,
      );
    }
  }

  await saveManifest(pieceId, manifest);

  // One-way data flow: the canvas re-renders off this invalidation, not off
  // local state. Skipping it leaves the user staring at the old frame.
  navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });

  return { width, height, previousWidth, previousHeight, warnings };
}
