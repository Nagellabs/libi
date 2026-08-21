/**
 * Resolve a SelectionStore id (a single string space shared by overlay and
 * audio-clip ids) into what it points at. Pure; used by the inspector +
 * timeline. NO DOM.
 */
import type { AudioClip, Composition, Overlay } from "@/lib/engine/types";

export type ClassifiedSelection =
  | { kind: "overlay"; overlay: Overlay }
  | { kind: "audioClip"; clip: AudioClip }
  | null;

export function classifySelection(
  id: string | null,
  composition: Composition | null,
): ClassifiedSelection {
  if (!id || !composition) return null;
  const overlay = composition.overlays?.find((o) => o.id === id);
  if (overlay) return { kind: "overlay", overlay };
  const clip = composition.audioClips?.find((c) => c.id === id);
  if (clip) return { kind: "audioClip", clip };
  return null;
}
