/**
 * Resolve a SelectionStore id (a single string space shared by scene, overlay,
 * and audio-clip ids) into what it points at. Pure; used by the inspector +
 * timeline. NO DOM.
 */
import type { AudioClip, Composition, Overlay, Scene } from "@/lib/engine/types";

export type ClassifiedSelection =
  | { kind: "overlay"; overlay: Overlay }
  | { kind: "scene"; scene: Scene; index: number }
  | { kind: "audioClip"; clip: AudioClip }
  | null;

export function classifySelection(
  id: string | null,
  composition: Composition | null,
): ClassifiedSelection {
  if (!id || !composition) return null;
  const overlay = composition.overlays?.find((o) => o.id === id);
  if (overlay) return { kind: "overlay", overlay };
  const index = composition.scenes.findIndex((s) => s.id === id);
  if (index >= 0) return { kind: "scene", scene: composition.scenes[index], index };
  const clip = composition.audioClips?.find((c) => c.id === id);
  if (clip) return { kind: "audioClip", clip };
  return null;
}
