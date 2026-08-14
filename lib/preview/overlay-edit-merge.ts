import type { Composition, Overlay } from "@/lib/engine/types";
import type { OverlayEditEntry } from "./overlay-edit-store";

/**
 * Returns a composition whose overlays have any pending local edits merged in.
 * Identity (same reference) when there are no edits, so memo consumers don't
 * needlessly re-render. The server composition is never mutated.
 */
export function mergeOverlayEdits(
  composition: Composition | null,
  edits: ReadonlyMap<string, OverlayEditEntry>,
): Composition | null {
  if (!composition) return null;
  if (edits.size === 0) return composition;
  const overlays = composition.overlays;
  if (!overlays || overlays.length === 0) return composition;
  let changed = false;
  const next = overlays.map((o) => {
    const e = edits.get(o.id);
    if (!e) return o;
    changed = true;
    return { ...o, ...e.patch } as Overlay;
  });
  if (!changed) return composition;
  return { ...composition, overlays: next };
}
