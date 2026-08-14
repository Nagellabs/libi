"use client";

import { useEffect, useRef, useState } from "react";
import type { Composition } from "@/lib/engine/types";
import type { OverlayQuadInstance } from "@/lib/engine/overlay-quad";
import type { OverlayRendererPool } from "@/lib/engine/three-overlay";
import { overlayNeedsSpatialQuad } from "@/lib/export/render-entry-quads";

/**
 * Builds + caches an OverlayQuadInstance per spatial 2D overlay. "Spatial 2D"
 * means an overlay of kind image / video / code / (text without threeD) whose
 * resolved Transform3D classifies as "spatial" (out-of-plane: rotation.x/y ≠ 0
 * or position.z ≠ 0). Three / 3D-text overlays are excluded — they own the
 * shared three renderer and apply their transform there.
 *
 * Owns its OWN SharedThreeRenderer (separate from the three-scene hook) created
 * via `createSharedThreeRenderer()`. Instances build asynchronously (WebGL +
 * three.js import); until an overlay's instance is ready it is absent from the
 * returned map and the renderer's spatial dispatch no-ops (no flash, no throw).
 *
 * Rebuilds an instance only when an overlay ENTERS the spatial set (newly added
 * or changed from planar to spatial). The quad instance is content-agnostic —
 * it re-textures each render — so no per-content signature is needed. Disposes
 * instances whose overlay left the spatial set (removed or no longer spatial).
 */
export function useOverlayQuads(composition: Composition | null): {
  spatialQuads: Record<string, OverlayQuadInstance>;
} {
  const [spatialQuads, setSpatialQuads] = useState<Record<string, OverlayQuadInstance>>({});
  // Per-overlay renderer pool — each spatial quad gets its OWN WebGLRenderer so
  // its per-frame setSize never reallocs another overlay's GL buffer (the
  // measured GC-stutter cause; see docs-local/superpowers/notes/smoothness-fixture.md).
  const poolRef = useRef<OverlayRendererPool | null>(null);
  const instRef = useRef<Record<string, OverlayQuadInstance>>({});

  useEffect(() => {
    let cancelled = false;
    const all = composition?.overlays ?? [];

    // Select "spatial 2D" overlays via the SHARED selector — the export path
    // (`render-entry-quads.ts`) uses the exact same predicate, so preview and
    // export can never diverge on which overlays get a quad.
    const spatialOverlays = all.filter(overlayNeedsSpatialQuad);

    // Dispose instances whose overlay left the spatial set.
    const liveIds = new Set(spatialOverlays.map((o) => o.id));
    let removedAny = false;
    for (const id of Object.keys(instRef.current)) {
      if (!liveIds.has(id)) {
        instRef.current[id]?.dispose();
        poolRef.current?.release(id); // free this overlay's dedicated renderer
        delete instRef.current[id];
        removedAny = true;
      }
    }
    if (removedAny && spatialOverlays.length > 0) {
      setSpatialQuads({ ...instRef.current });
    }

    if (spatialOverlays.length === 0) {
      if (Object.keys(instRef.current).length === 0) setSpatialQuads({});
      return;
    }

    (async () => {
      const { createOverlayRendererPool } = await import("@/lib/engine/three-overlay");
      const { buildQuadInstance } = await import("@/lib/engine/overlay-quad");
      if (cancelled) return;
      if (!poolRef.current) poolRef.current = createOverlayRendererPool();

      let changed = false;

      for (const o of spatialOverlays) {
        // Already built — the quad is content-agnostic, no rebuild needed.
        if (instRef.current[o.id]) continue;
        try {
          const renderer = await poolRef.current.acquire(o.id);
          if (cancelled) return;
          const inst = await buildQuadInstance(renderer);
          if (cancelled) { inst.dispose(); return; }
          instRef.current[o.id] = inst;
          changed = true;
        } catch {
          // Build failed (WebGL unavailable, etc.) — overlay no-ops this frame.
        }
      }

      if (changed && !cancelled) setSpatialQuads({ ...instRef.current });
    })();

    return () => { cancelled = true; };
  }, [composition]);

  // Dispose everything on unmount.
  useEffect(() => {
    return () => {
      for (const inst of Object.values(instRef.current)) inst.dispose();
      instRef.current = {};
      poolRef.current?.disposeAll();
      poolRef.current = null;
    };
  }, []);

  return { spatialQuads };
}
