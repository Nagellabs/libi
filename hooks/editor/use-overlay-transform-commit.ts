"use client";

import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { pieceKeys } from "@/lib/queries/pieces";
import type { OverlayEditStore } from "@/lib/preview/overlay-edit-store";
import type { Overlay } from "@/lib/engine/types";
import { overlayKeyframeTimes } from "@/lib/overlays/keyframes";
import {
  autoKeyframeCommit,
  mergePendingKeyframe,
  type AutoKeyframeField,
  type PendingKeyframe,
} from "@/lib/overlays/auto-keyframe";
import type {
  OverlayRect,
  CaptionBackground,
  CaptionStroke,
  CaptionShadow,
  CaptionReveal,
  Transform3D,
  TextThreeD,
} from "@/lib/engine/types";

/** The transform/timing/group fields a manual edit may PATCH. All optional —
 *  whatever the gesture changed. Matches the route's UpdateOverlayBodySchema.
 *  In-plane spin is NOT a member here — it lives on `transform3d.rotation.z`
 *  (the single rotation authority); a rotate gesture commits `transform3d`.
 *  Milestone 4 added the text-caption styling fields via the CaptionInspector. */
export interface OverlayTransformPatch {
  rect?: OverlayRect;
  flipH?: boolean;
  flipV?: boolean;
  /** Eye toggle — layer OFF everywhere. Flat-PATCH only; NEVER keyframed
   *  (AUTO_KEYFRAME_FIELDS whitelists rect/opacity/transform3d, so the
   *  keyframe-aware branch can't capture it). */
  hidden?: boolean;
  // TRACKED overlays — the persistent follow offset (fractions of the resolved
  // art box). Reset = {x:0, y:0}; no null sentinel.
  offset?: { x: number; y: number };
  // TRACKED overlays — art size relative to the tracked box (uniform; the
  // preview corner handles write it). Bounded (0, 5] by updateOverlaySchema.
  scale?: number;
  group?: string;
  opacity?: number;
  startTime?: number;
  duration?: number;
  z?: number;
  // Text-caption styling (CaptionInspector). The PATCH route accepts these via
  // updateOverlaySchema's captionStyleUpdateFields. For background/stroke/shadow/
  // reveal, an explicit `null` is the clear-key sentinel (deletes the field
  // server-side); `undefined`/absent leaves it unchanged.
  content?: string;
  font?: string;
  color?: string;
  align?: "left" | "center" | "right";
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number | string;
  lineHeight?: number;
  // Point-text placement (TEXT overlays). `anchor` + `position` pin one of the
  // 9 anchor points of the MEASURED glyph box to a composition-pixel point; the
  // derived `rect` is recomputed server-side on save (placeBoxAtAnchor). Written
  // by the point-text canvas handles (corner-scale writes fontSize+position;
  // body-drag writes position). Accepted by updateOverlaySchema.
  anchor?: import("@/lib/captions/types").CaptionAnchor;
  position?: { x: number; y: number };
  maxWidthPct?: number;
  background?: CaptionBackground | null;
  stroke?: CaptionStroke | null;
  shadow?: CaptionShadow | null;
  reveal?: CaptionReveal | null;
  // Three-overlay 3D transform (ThreeInspector + orbit gizmo). The PATCH route
  // accepts these via updateOverlaySchema's three-overlay fields.
  transform3d?: Transform3D;
  cameraPreset?: "billboard" | "ground" | "lowAngle" | "highAngle" | "angled";
  // Universal 3D gate (ThreeDFields / CaptionInspector "Make it 3D" toggle). A
  // UI-only gate (the renderer reads transform3d, not this) persisted so the
  // toggle stays on even when every angle is zero. `threeD` is text extrusion;
  // `null` clears it (text disable-3D path).
  place3d?: boolean;
  threeD?: TextThreeD | null;
}

export interface UseOverlayTransformCommit {
  /**
   * Apply `patch` to the client edit store (instant paint), then schedule a
   * trailing-debounced background flush that persists it to the server.
   */
  commit: (overlayId: string, patch: OverlayTransformPatch) => void;
  /**
   * Force the pending edit for `overlayId` to persist NOW (cancels the
   * debounce). Used by pointer-up to commit immediately instead of waiting.
   */
  flush: (overlayId: string) => void;
}

/**
 * Phase 5b AUTO-KEYFRAMING wiring. When supplied, an overlay that ALREADY has
 * ≥1 keyframe routes its rect / opacity / transform3d edits to the keyframes
 * route at the playhead time instead of the flat PATCH. A still-constant
 * overlay (no keyframes) — or any consumer that omits this config — edits
 * EXACTLY as before (flat PATCH), byte-for-byte. Read the playhead
 * IMPERATIVELY (`playheadTime()`) so this never subscribes to the 30 Hz frame.
 */
export interface AutoKeyframeConfig {
  /** Resolve the current overlay record (for `keyframes` / `startTime` / `duration`). */
  resolveOverlay: (overlayId: string) => Overlay | undefined;
  /** Composition-global playhead time in seconds, read imperatively at commit. */
  playheadTime: () => number;
  /**
   * POST a keyframe upsert at `time` (SECONDS within the clip) with `properties`
   * (`{ rect | opacity | transform3d: value }`). Fire-and-forget; the route
   * emits `refresh_query composition` and the merge reconciler catches up.
   */
  addKeyframe: (overlayId: string, time: number, properties: Record<string, unknown>) => void;
}

/** The three animatable fields a manual edit may carry into a keyframe. */
const AUTO_KEYFRAME_FIELDS: readonly AutoKeyframeField[] = ["rect", "opacity", "transform3d"];

/** Trailing-debounce window for the background PATCH (ms). */
const FLUSH_DEBOUNCE_MS = 250;

/** The cached `usePieceComposition` response shape (overlays at manifest.overlays). */
interface CachedComposition {
  manifest: { overlays?: Overlay[] } & Record<string, unknown>;
  scenes: unknown;
  audioClips: unknown;
}

/**
 * Pure cache-update helper: applies `patch` onto the cached overlay with id
 * `overlayId`, mirroring the route's clear-key semantics (a `null` patch value
 * DELETES that key in the cache copy). Also writes `version` when present.
 * Null-safe: returns `prev` unchanged when it's undefined or the overlay is
 * absent, so a missing cache never throws.
 */
function applyPatchToCache(
  prev: CachedComposition | undefined,
  overlayId: string,
  patch: OverlayTransformPatch,
  version: number | undefined,
): CachedComposition | undefined {
  if (!prev) return prev;
  const overlays = prev.manifest.overlays;
  if (!overlays) return prev;
  const idx = overlays.findIndex((o) => o.id === overlayId);
  if (idx < 0) return prev;

  const next = { ...(overlays[idx] as unknown as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      // Route treats `null` as the clear-key sentinel — mirror it here.
      delete next[key];
    } else if (value !== undefined) {
      next[key] = value;
    }
  }
  if (version != null) next.version = version;

  const nextOverlays = overlays.slice();
  nextOverlays[idx] = next as unknown as Overlay;
  return {
    ...prev,
    manifest: { ...prev.manifest, overlays: nextOverlays },
  };
}

/**
 * Commit a manual overlay transform edit.
 *
 * Two-stage design (flash-free):
 *   1. `commit` applies the patch to the client edit store synchronously — the
 *      merged composition paints it THIS frame — then schedules a trailing
 *      debounced flush. Re-committing the same overlay coalesces (the store
 *      merges patches; the timer resets).
 *   2. `flush` PATCHes the cumulative pending patch. On success it writes the
 *      saved value into the React Query composition cache. It does NOT drop the
 *      store override — that is owned by the data-gated reconciler in
 *      `useMergedOverlayEdits`, which drops a committed override only once the
 *      rendered composition's overlay PROVABLY reflects the patch. Dropping it
 *      here the instant the PATCH resolved raced the composition rebuild + a
 *      stale `refresh_query` refetch from an earlier drag, which briefly flashed
 *      the previous position on fast/repeated drags. Keeping the override until
 *      the composition catches up means no frame can show a stale value.
 *
 * On a failed/erroring PATCH the pending edit is RETAINED (no cache write) — a
 * later commit/flush retries. The override likewise persists (the reconciler
 * only drops on a reflected value), so the unsaved edit keeps painting.
 */
export function useOverlayTransformCommit(
  pieceId: string | null,
  store: OverlayEditStore,
  autoKeyframe?: AutoKeyframeConfig,
): UseOverlayTransformCommit {
  const queryClient = useQueryClient();
  // Keep the auto-keyframe config in a ref so `commit`'s identity stays stable
  // across playhead ticks / composition refetches (config functions change
  // identity often; the ref lets `commit` read the latest without re-creating).
  const autoKeyframeRef = useRef(autoKeyframe);
  useEffect(() => {
    autoKeyframeRef.current = autoKeyframe;
  });
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // The store version + cumulative patch as of the LAST `commit` for an
  // overlay. The new edit store has no `get`/`pending` read API, so the hook
  // remembers what each `commit` produced and threads that version into
  // `confirm` on flush. A re-commit overwrites both (the merge is in the store);
  // a successful flush deletes the entry.
  const pending = useRef(
    new Map<string, { version: number; patch: OverlayTransformPatch }>(),
  );
  // Phase 5b: the debounced keyframe intent per overlay. `commit` accumulates the
  // latest `{ time, properties }` per animatable field (merging by field) during
  // a drag and PAINTS per-tick; the trailing-debounce timer fires ONE
  // `addKeyframe` POST per overlay when the drag settles (mirroring how the flat
  // `flush` coalesces the flat PATCH). Without this, dragging an animated overlay
  // POSTed a keyframe (manifest write + refetch) on every mouse-move.
  const pendingKeyframes = useRef(new Map<string, PendingKeyframe>());

  const flush = useCallback(
    async (overlayId: string) => {
      const t = timers.current.get(overlayId);
      if (t) {
        clearTimeout(t);
        timers.current.delete(overlayId);
      }

      // Fire the debounced keyframe POST (Issue 1) once the drag settles. This
      // runs on the SAME per-overlay trailing-debounce timer as the flat flush,
      // so flat fields + keyframe fields both land at settle. Fire-and-forget:
      // the keyframes route emits `refresh_query composition` and the merge
      // reconciler catches up. Cleared after firing.
      const kf = pendingKeyframes.current.get(overlayId);
      if (kf) {
        pendingKeyframes.current.delete(overlayId);
        autoKeyframeRef.current?.addKeyframe(overlayId, kf.time, kf.properties);
      }

      const entry = pending.current.get(overlayId);
      if (!entry || !pieceId) return;

      const sentVersion = entry.version;
      const patch = entry.patch;

      let res: Response;
      try {
        res = await fetch(`/api/pieces/${pieceId}/overlays/${overlayId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
      } catch (err) {
        console.error("overlay.transform network error:", err);
        return; // keep pending; retry on a later commit/flush
      }

      if (!res.ok) {
        console.error(
          `overlay.transform commit failed: ${res.status}`,
          await res.text().catch(() => ""),
        );
        return; // keep pending
      }

      const { version } = (await res.json().catch(() => ({}))) as {
        version?: number;
      };

      // Optimistically write the saved value into the composition cache so the
      // rendered composition carries it promptly. We DO NOT drop the store
      // override here — that is now owned by the data-gated reconciler in
      // `useMergedOverlayEdits`, which drops a committed override only once the
      // rendered composition's overlay PROVABLY reflects the patch. Dropping it
      // here (the moment the PATCH resolved) raced the composition rebuild and a
      // stale `refresh_query` refetch from an earlier drag, briefly flashing the
      // previous position. Keeping the override until the composition catches up
      // masks any stale intermediate value instead.
      queryClient.setQueryData<CachedComposition>(
        pieceKeys.composition(pieceId),
        (prev) => applyPatchToCache(prev, overlayId, patch, version),
      );

      // Drop our local PATCH-bookkeeping entry IFF the user hasn't edited again
      // since we captured sentVersion (else it stays pending for the next flush).
      const latest = pending.current.get(overlayId);
      if (latest && latest.version <= sentVersion) {
        pending.current.delete(overlayId);
      }
    },
    [pieceId, queryClient, store],
  );

  const commit = useCallback(
    (overlayId: string, patch: OverlayTransformPatch) => {
      if (!overlayId) return;

      // ── Phase 5b AUTO-KEYFRAMING split ──────────────────────────────────
      // If the overlay already has ≥1 keyframe AND auto-keyframe wiring is
      // present, its rect / opacity / transform3d edits become keyframe upserts
      // at the playhead instead of flat base-field writes. Any NON-animatable
      // fields in the same patch (timing, z, caption styling, …) still take the
      // flat path. A constant overlay (no keyframes) or an unwired consumer
      // leaves `flatPatch === patch` — the flat path below is UNCHANGED.
      let flatPatch: OverlayTransformPatch = patch;
      const cfg = autoKeyframeRef.current;
      if (cfg) {
        const overlay = cfg.resolveOverlay(overlayId);
        if (overlay && overlayKeyframeTimes(overlay).length > 0) {
          const rest: OverlayTransformPatch = { ...patch };
          let routedAny = false;
          const startTime = overlay.startTime;
          const duration = overlay.duration;
          const playheadTime = cfg.playheadTime();
          for (const field of AUTO_KEYFRAME_FIELDS) {
            const value = patch[field];
            if (value === undefined) continue;
            const decision = autoKeyframeCommit({
              hasKeyframes: true,
              field,
              value,
              playheadTime,
              startTime,
              duration,
            });
            if (decision.mode !== "keyframe") continue;
            // Instant paint: keep the store override so the canvas shows the
            // edit THIS frame. The keyframe POST → refresh_query → composition
            // refetch reconciles it.
            // TODO(keyframe-reconcile): `store.commit` records a COMMITTED
            // override that the `useMergedOverlayEdits` reconciler only drops
            // once `reflectsPatch(overlay, {[field]:value})` matches the overlay's
            // BASE field. But the keyframe route writes the value into
            // `overlay.keyframes.<field>`, NOT the base field — so the base never
            // reflects the patch and the override stays pinned for the session
            // (and would paint the stale dragged value if the user later CLEARS
            // all keyframes, reverting to the base field). Neither clean fix was
            // available: the store's `preview()` channel is imperative-only (not
            // dropped on refetch, so it would pin the same way on the canvas), and
            // `addKeyframe` (→ `keyframeOps.add.mutate`) is fire-and-forget with
            // no onSuccess threaded here to `store.confirm` the override. Deferred
            // as a follow-up — Issue 1 (per-tick POST) is the priority.
            store.commit(overlayId, { [field]: value } as Partial<Overlay>);
            // Debounce the keyframe POST (Issue 1): accumulate the latest intent
            // per field; the trailing-debounce timer fires ONE POST at settle.
            pendingKeyframes.current.set(
              overlayId,
              mergePendingKeyframe(pendingKeyframes.current.get(overlayId), {
                time: decision.time,
                properties: decision.properties,
              }),
            );
            delete (rest as Record<string, unknown>)[field];
            routedAny = true;
          }
          if (routedAny) flatPatch = rest;
        }
      }

      // If every field was routed to keyframes, there is no flat PATCH to run —
      // but we STILL schedule the debounce timer so the accumulated keyframe POST
      // fires at settle. Skip only when there's neither a flat patch NOR a pending
      // keyframe (nothing to do).
      const hasFlat = Object.keys(flatPatch).length > 0;
      if (!hasFlat) {
        if (pendingKeyframes.current.has(overlayId)) {
          const existing = timers.current.get(overlayId);
          if (existing) clearTimeout(existing);
          const handle = setTimeout(() => {
            void flush(overlayId);
          }, FLUSH_DEBOUNCE_MS);
          timers.current.set(overlayId, handle);
        }
        return;
      }

      // 1. Paint this frame: commit flips any preview entry to committed (so the
      //    canvas's React merge picks it up) and returns the new version. Capture
      //    it + the cumulative patch so flush can PATCH it and `confirm` the
      //    drop. The store merges patches; mirror the merge onto our ref.
      const version = store.commit(overlayId, flatPatch as Partial<Overlay>);
      const prev = pending.current.get(overlayId)?.patch ?? {};
      pending.current.set(overlayId, { version, patch: { ...prev, ...flatPatch } });
      // 2. (Re)schedule the trailing-debounced background flush.
      const existing = timers.current.get(overlayId);
      if (existing) clearTimeout(existing);
      const handle = setTimeout(() => {
        void flush(overlayId);
      }, FLUSH_DEBOUNCE_MS);
      timers.current.set(overlayId, handle);
    },
    [store, flush],
  );

  // Clear any outstanding timers on unmount, flushing any pending keyframe POSTs
  // first (Issue 1) so a keyframe accumulated by an in-flight drag isn't lost
  // when the component unmounts before the debounce fires. Fire-and-forget POST.
  const timersRef = timers;
  const pendingKeyframesRef = pendingKeyframes;
  const autoKeyframeCleanupRef = autoKeyframeRef;
  useEffect(() => {
    const kfRef = pendingKeyframesRef;
    const cfgRef = autoKeyframeCleanupRef;
    return () => {
      for (const t of timersRef.current.values()) clearTimeout(t);
      timersRef.current.clear();
      for (const [overlayId, kf] of kfRef.current) {
        cfgRef.current?.addKeyframe(overlayId, kf.time, kf.properties);
      }
      kfRef.current.clear();
    };
  }, [timersRef, pendingKeyframesRef, autoKeyframeCleanupRef]);

  return {
    commit,
    flush: (overlayId: string) => {
      void flush(overlayId);
    },
  };
}
