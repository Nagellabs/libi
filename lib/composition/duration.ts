import type { CompositionManifest } from "@/lib/composition/persistence";

/**
 * The piece's current length in seconds.
 *
 * A piece has no stored duration — it is derived from its contents, exactly
 * as `getCompositionFrames` (lib/engine/renderer.ts) derives the frame count.
 * Kept seconds-based and dependency-free so MCP tool code can ask this
 * question without importing the canvas renderer.
 *
 * Consequence worth remembering: "extend the piece" is never a write of its
 * own — it is simply declining to trim the clip being added.
 */
export function pieceDurationSec(
  manifest: Pick<CompositionManifest, "overlays" | "audioClips">,
): number {
  const endOf = (item: { startTime?: number; duration?: number }) =>
    (item.startTime ?? 0) + (item.duration ?? 0);
  let max = 0;
  for (const o of manifest.overlays ?? []) max = Math.max(max, endOf(o));
  for (const c of manifest.audioClips ?? []) max = Math.max(max, endOf(c));
  return max;
}
