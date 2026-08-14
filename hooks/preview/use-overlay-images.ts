"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { Composition, Overlay } from "@/lib/engine/types";

interface ImageEntry {
  img: HTMLImageElement;
  fileId: string;
}

/** Extracts (overlayId, fileId) pairs from all image-like overlays:
 *  plain `image` overlays and `tracked` overlays whose content is an image. */
function pickImageOverlays(overlays: Overlay[]): Array<{ overlayId: string; fileId: string }> {
  const out: Array<{ overlayId: string; fileId: string }> = [];
  for (const o of overlays) {
    if (o.kind === "image") {
      out.push({ overlayId: o.id, fileId: o.fileId });
    } else if (o.kind === "tracked" && o.content.kind === "image") {
      out.push({ overlayId: o.id, fileId: o.content.fileId });
    }
  }
  return out;
}

/**
 * The HTMLImageElement cache as a tiny external store: the map of live <img>
 * elements is external mutable state (browser resources, not render data), so
 * it is published to React through useSyncExternalStore instead of a
 * setState-inside-effect cascade. `reconcile` only emits when the keyed set
 * actually changed, so identical SSE refetches never re-render consumers.
 */
function createImageStore() {
  const map = new Map<string, ImageEntry>();
  let snapshot: Record<string, HTMLImageElement> = {};
  const listeners = new Set<() => void>();

  const publish = () => {
    const next: Record<string, HTMLImageElement> = {};
    for (const [id, entry] of map) next[id] = entry.img;
    snapshot = next;
    for (const l of listeners) l();
  };

  const load = (overlayId: string, fileId: string) => {
    const img = new Image();
    img.src = `/api/files/by-id/${fileId}/content`;
    img.crossOrigin = "anonymous";
    map.set(overlayId, { img, fileId });
  };

  return {
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getSnapshot: () => snapshot,
    reconcile(composition: Composition | null) {
      if (!composition) {
        if (map.size === 0) return;
        for (const entry of map.values()) entry.img.src = "";
        map.clear();
        publish();
        return;
      }

      const active = new Set<string>();
      let changed = false;

      for (const { overlayId, fileId } of pickImageOverlays(composition.overlays ?? [])) {
        active.add(overlayId);
        const existing = map.get(overlayId);
        if (!existing) {
          load(overlayId, fileId);
          changed = true;
        } else if (existing.fileId !== fileId) {
          existing.img.src = "";
          load(overlayId, fileId);
          changed = true;
        }
      }

      for (const [id, entry] of map) {
        if (!active.has(id)) {
          entry.img.src = "";
          map.delete(id);
          changed = true;
        }
      }

      if (changed) publish();
    },
    dispose() {
      for (const entry of map.values()) entry.img.src = "";
      map.clear();
    },
  };
}

/**
 * Owns HTMLImageElement lifecycle for every image overlay in the composition.
 * Keyed by overlay.id. Reuses the same <img> across composition refetches as
 * long as (overlay.id, fileId) is stable — without this, every SSE-triggered
 * refetch would re-download every overlay image and flash the preview.
 *
 * Also handles tracked overlays whose content.kind === "image" — same keying
 * and lifecycle, just sourced from content.fileId instead of overlay.fileId.
 *
 * Mirrors the pattern in hooks/preview/use-video-sources.ts.
 */
export function useOverlayImages(composition: Composition | null): {
  images: Record<string, HTMLImageElement>;
} {
  const [store] = useState(createImageStore);
  const images = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    store.reconcile(composition);
  }, [store, composition]);

  useEffect(() => () => store.dispose(), [store]);

  return { images };
}
