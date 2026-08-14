// lib/captions/group.ts
import type { Overlay, TextOverlay } from "@/lib/engine/types";

export function captionCuesOf(overlays: Overlay[], groupId: string): TextOverlay[] {
  return overlays
    .filter((o): o is TextOverlay => o.kind === "text" && o.caption?.groupId === groupId)
    .sort((a, b) => a.startTime - b.startTime);
}

/** Ids of cues a scope targets. scope "all" → every cue still synced
 *  (useTrackStyle !== false); scope "cue" → just cueId. */
export function resolveScopeTargets(
  overlays: Overlay[],
  groupId: string,
  scope: "all" | "cue",
  cueId?: string,
): string[] {
  if (scope === "cue") return cueId ? [cueId] : [];
  return captionCuesOf(overlays, groupId)
    .filter((o) => o.caption?.useTrackStyle !== false)
    .map((o) => o.id);
}

/** The group's shared styleRef (from the first synced cue), or null. */
export function groupStyleRef(overlays: Overlay[], groupId: string): string | null {
  const first = captionCuesOf(overlays, groupId).find((o) => o.caption?.useTrackStyle !== false);
  return first?.caption?.styleRef ?? null;
}
