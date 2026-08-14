"use client";

import { useEffect, useRef, useState } from "react";
import type { Composition } from "@/lib/engine/types";
import type { ThreeOverlayInstance, OverlayRendererPool } from "@/lib/engine/three-overlay";
import { textUsesThreeInstance, withSynthesizedThreeD } from "@/lib/overlays/three-d-mode";

/**
 * Builds + caches a ThreeOverlayInstance per `three` overlay. Owns the single
 * shared WebGLRenderer's lifecycle. Instances build asynchronously (lazy three
 * import + canvas-text rasterization); until an overlay's instance is ready it is absent from
 * the returned map and the renderer's `case "three"` no-ops (no flash, no throw).
 *
 * Re-builds an instance when its `sceneFunction` or `cameraPreset` changes;
 * disposes instances for overlays that were removed.
 *
 * When a rebuild throws (the agent saved a broken `scene.jsx`), the previously
 * built instance is RETAINED (last-good — no flash to empty) and the error is
 * surfaced in `errors` so the overlay error badge can render over the rect.
 */
export function useOverlayThreeScenes(composition: Composition | null): {
  threeScenes: Record<string, ThreeOverlayInstance>;
  /** overlayId → build-error message (only present for currently-broken overlays). */
  errors: Record<string, string>;
} {
  const [threeScenes, setThreeScenes] = useState<Record<string, ThreeOverlayInstance>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Per-overlay renderer pool: each 3D overlay gets its OWN WebGLRenderer so its
  // per-frame render() only ever resizes its own GL buffer (the shared-renderer
  // setSize realloc thrash was the measured cause of the GC-pause stutter — see
  // docs-local/superpowers/notes/smoothness-fixture.md).
  const poolRef = useRef<OverlayRendererPool | null>(null);
  // Cache of source signatures so we only rebuild on real change.
  const sigRef = useRef<Record<string, string>>({});
  const instRef = useRef<Record<string, ThreeOverlayInstance>>({});
  // Last-good build error per overlay id (mirrors the published `errors` state).
  const errRef = useRef<Record<string, string>>({});
  // Whether the LAST published `threeScenes` was non-empty. Guards the empty
  // path from re-setting a fresh `{}` every run: that re-render is a no-op
  // semantically but a NEW object identity, which — paired with an unstable
  // `composition` prop — used to spin into "Maximum update depth exceeded".
  const publishedNonEmptyRef = useRef(false);
  // Publish the current instance map, tracking emptiness so we never re-set an
  // already-empty map to a new `{}`.
  const publish = () => {
    const nonEmpty = Object.keys(instRef.current).length > 0;
    if (!nonEmpty && !publishedNonEmptyRef.current) return; // already empty — skip
    setThreeScenes({ ...instRef.current });
    publishedNonEmptyRef.current = nonEmpty;
  };

  useEffect(() => {
    let cancelled = false;
    const all = composition?.overlays ?? [];
    const threeOverlays = all.filter((o) => o.kind === "three");
    // Text overlays in 3D mode (place3d) OR with extrusion (`threeD`) get a built
    // three instance, rendered by the unified renderer's `case "text"` (falls back
    // to flat 2D when absent). place3d-without-extrusion is the common "tilt my
    // text in space" case — it MUST use the instance so Depth (world-unit
    // position.z) actually moves it; the flat-quad path's z factor is negligible.
    const textThreeOverlays = all.filter((o) => textUsesThreeInstance(o));

    // Dispose instances whose overlay was removed.
    const liveIds = new Set([...threeOverlays, ...textThreeOverlays].map((o) => o.id));
    let removedAny = false;
    for (const id of Object.keys(instRef.current)) {
      if (!liveIds.has(id)) {
        instRef.current[id]?.dispose();
        poolRef.current?.release(id); // free this overlay's dedicated renderer
        delete instRef.current[id];
        delete sigRef.current[id];
        removedAny = true;
      }
    }
    // Clear errors for overlays that no longer exist.
    let errChanged = false;
    for (const id of Object.keys(errRef.current)) {
      if (!liveIds.has(id)) {
        delete errRef.current[id];
        errChanged = true;
      }
    }
    // Republish so a removed overlay's stale key doesn't linger in state while
    // sibling instances remain. Harmless to render (renderFrame only looks up by
    // live overlay id) — this just keeps the published map honest.
    const totalThree = threeOverlays.length + textThreeOverlays.length;
    if (removedAny && totalThree > 0) publish();

    if (totalThree === 0) {
      // Nothing 3D — publish empty (guarded: a no-op once already empty), keep
      // the shared renderer for reuse.
      publish();
      if (Object.keys(errRef.current).length === 0 && errChanged) setErrors({});
      else if (errChanged) setErrors({ ...errRef.current });
      return;
    }

    if (errChanged) setErrors({ ...errRef.current });

    (async () => {
      const { createOverlayRendererPool, buildThreeInstance } = await import("@/lib/engine/three-overlay");
      if (!poolRef.current) poolRef.current = createOverlayRendererPool();
      if (cancelled) return;

      let changed = false;
      let errsChanged = false;

      const onBuilt = (id: string, inst: import("@/lib/engine/three-overlay").ThreeOverlayInstance, sig: string) => {
        instRef.current[id]?.dispose();
        instRef.current[id] = inst;
        sigRef.current[id] = sig;
        changed = true;
        if (errRef.current[id]) { delete errRef.current[id]; errsChanged = true; }
      };
      const onError = (id: string, err: unknown) => {
        // Broken body: RETAIN the last-good instance (no flash) and record the
        // error. Do NOT update sigRef so a later fix triggers a rebuild.
        errRef.current[id] = err instanceof Error ? err.message : String(err);
        errsChanged = true;
      };

      // ── `three` overlays (scene bodies) ──
      for (const o of threeOverlays) {
        if (o.kind !== "three") continue;
        const sig = `${o.cameraPreset ?? "billboard"}::${o.sceneFunction}`;
        if (sigRef.current[o.id] === sig && instRef.current[o.id]) continue;
        try {
          const renderer = await poolRef.current.acquire(o.id);
          if (cancelled) return;
          const inst = await buildThreeInstance(o.sceneFunction, o.cameraPreset, renderer);
          await inst.ready;
          if (cancelled) { inst.dispose(); return; }
          onBuilt(o.id, inst, sig);
        } catch (err) {
          onError(o.id, err);
        }
      }

      // ── `text` overlays carrying `threeD` ──
      if (textThreeOverlays.length > 0) {
        const [{ buildTextThreeInstance }, { makeBrowserTextThreeDeps }] = await Promise.all([
          import("@/lib/engine/text-3d/build-text-three"),
          import("@/lib/engine/text-3d/browser-deps"),
        ]);
        if (cancelled) return;
        const deps = makeBrowserTextThreeDeps();
        for (const o of textThreeOverlays) {
          if (o.kind !== "text" || !textUsesThreeInstance(o)) continue;
          // 3D-mode text with no extrusion has no `threeD`; the builder needs one,
          // so synthesize a flat (depth:0) default at BUILD time only — never
          // persisted, so the Extrude toggle (which reads overlay.threeD) stays
          // independent / off. Shared with the export build loop.
          const buildOverlay = withSynthesizedThreeD(o);
          // Rebuild signature captures every field that changes the built geometry
          // or reveal behaviour (incl. place3d, which flips the instance on/off).
          const sig = `text3d::${o.content}::${o.fontFamily ?? ""}::${o.fontFileId ?? ""}::${o.color}::${o.place3d ? 1 : 0}::${JSON.stringify(o.threeD ?? null)}::${JSON.stringify(o.reveal ?? null)}`;
          if (sigRef.current[o.id] === sig && instRef.current[o.id]) continue;
          try {
            const renderer = await poolRef.current.acquire(o.id);
            if (cancelled) return;
            const inst = await buildTextThreeInstance(buildOverlay, deps, renderer);
            await inst.ready;
            if (cancelled) { inst.dispose(); return; }
            onBuilt(o.id, inst, sig);
          } catch (err) {
            onError(o.id, err);
          }
        }
      }

      if (changed && !cancelled) publish();
      if (errsChanged && !cancelled) setErrors({ ...errRef.current });
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

  return { threeScenes, errors };
}
