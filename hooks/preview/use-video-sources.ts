"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Composition } from "@/lib/engine/types";
import type { FrameStore, SeekSignalStore } from "@/lib/preview/frame-store";
import type {
  VideoFrameSource,
  VideoFrameSourceError,
} from "@/lib/engine/video-frame-source";
import { MediaBunnyFrameSource } from "@/lib/engine/media-bunny-frame-source";
import {
  planSourceBudget,
  type BudgetClip,
  type SourceState,
} from "@/lib/preview/source-budget";
import { planMountWindow } from "@/lib/preview/mount-window";
import {
  previewMaxHeight,
  bucketDecodeHeight,
  SOURCE_BUDGET_K,
  WARM_AHEAD_SEC,
  MOUNT_AHEAD_SEC,
  MOUNT_BEHIND_SEC,
  MOUNT_HYSTERESIS_SEC,
  MOUNT_THUMB_CACHE,
  PAUSED_WARM_SETTLE_MS,
} from "@/lib/preview/tuning";
import { useEditorState } from "@/lib/editor-state-context";

/** The effective decode action a source is currently in, so `applyBudget` can be
 *  idempotent — it only issues a transition when this changes, never re-issuing
 *  `warm()`/`pause()`/`prime()` on a steady source (the per-tick churn that
 *  re-seeded/cleared the single decoder and emptied its ring). */
type EffectiveState = "active-playing" | "active-paused" | "warm" | "cold";

interface SourceEntry {
  source: MediaBunnyFrameSource;
  url: string;
  /** Decode-height cap this source was created with — reattach if it changes. */
  maxHeight: number;
  unsubscribeFrame: () => void;
  /** Last effective action applied by `applyBudget` (idempotency guard). */
  lastEffective?: EffectiveState;
  /** Last source-local time we primed to while paused (paused-scrub repaint
   *  de-dup, so a static pause doesn't re-decode every tick). */
  lastPrimedLocal?: number;
}

/** The minimal source surface `applyBudget` drives. Declared structurally so the
 *  budget logic is unit-testable with a fake source (no decoder/WebCodecs). */
export interface BudgetSource {
  play(): void;
  warm(fromSec: number): void;
  pause(): void;
  prime(t: number): Promise<void> | void;
}

/** The per-source entry `applyBudget` reads/writes — the live map uses the full
 *  `SourceEntry`; tests use a minimal `{ source }` with the idempotency fields. */
export interface BudgetEntry {
  source: BudgetSource;
  lastEffective?: EffectiveState;
  lastPrimedLocal?: number;
}

/**
 * Owns the video-frame-source lifecycle for a composition's video scenes
 * (+ video / tracked-video overlays). One `MediaBunnyFrameSource` per
 * scene.id / overlay.id; disposed when removed or the composition unmounts.
 *
 * Warming policy is the K-capped `planSourceBudget` (active / warm / cold); this
 * hook applies it. Overlay video sources follow the same budget (they have
 * geometry entries). The cut is a non-event — the renderer just asks each source
 * for the frame at the playhead.
 */
export function useVideoSources(
  composition: Composition | null,
  playing: boolean,
  speed: number = 1,
  /** Playhead frame store — the budget planner SUBSCRIBES to it imperatively
   *  (applyBudget is a side-effect: play/pause/warm/prime), so the host
   *  component does NOT re-render per frame. Passing the live `frame` number as a
   *  prop instead would force the whole preview-surface subtree (incl. the
   *  inspector) to reconcile 30 Hz — the measured post-edit GC stutter. */
  frameStore: FrameStore,
  /** Discrete USER-seek signal — when it fires (a scrub/jump, NOT the 30 Hz
   *  playback advance), every mounted source is HARD-seeked (flush + re-decode)
   *  so a seek lands on the target frame with no stale warm/ahead-frame replay.
   *  Optional so non-preview callers / tests can omit it. */
  seekSignal?: SeekSignalStore,
): {
  sources: Record<string, VideoFrameSource>;
  errors: Record<string, VideoFrameSourceError>;
} {
  const map = useRef<Map<string, SourceEntry>>(new Map());
  const [snapshot, setSnapshot] = useState<Record<string, VideoFrameSource>>({});

  // Per-device preview-quality preference → decode-height cap. Changing it
  // re-runs the effect below and reattaches every source at the new cap.
  const { previewQuality } = useEditorState();
  const maxDecodeHeight = previewMaxHeight(previewQuality);

  // ── Proximity-mount machinery (Phase 1A) ─────────────────────────────────
  // Mounting is driven by PLAYHEAD PROXIMITY (planMountWindow), not composition
  // membership: only clips active / near / recently-ended hold a live decoder, so
  // an N-clip timeline no longer keeps N decoders alive at once. The registry is
  // the full desired set (id → url + timeline span); reconcileMounts (run from the
  // frame tick, hysteretic) attaches the near set and disposes the far set.
  const maxHeightRef = useRef(maxDecodeHeight);
  maxHeightRef.current = maxDecodeHeight;
  const registry = useRef<
    Map<string, { url: string; startSec: number; endSec: number; decodeHeight: number }>
  >(new Map());
  const clipsRef = useRef<Array<{ id: string; startSec: number; endSec: number }>>([]);
  // Last-good thumbnail per recently-disposed source → seeds adoptLastGood on a
  // re-mount so a scrub-back never black-flashes. Bounded (LRU) so retention
  // can't defeat the memory win.
  const retainedThumbs = useRef<Map<string, CanvasImageSource>>(new Map());

  const bumpSnapshot = useCallback(() => setSnapshot((prev) => ({ ...prev })), []);
  const commitSnapshot = useCallback(() => {
    const next: Record<string, VideoFrameSource> = {};
    for (const [id, e] of map.current) next[id] = e.source;
    setSnapshot(next);
  }, []);

  const retainThumb = useCallback((id: string, frame: CanvasImageSource | null) => {
    if (!frame) return;
    const t = retainedThumbs.current;
    t.delete(id); // refresh LRU recency
    t.set(id, frame);
    while (t.size > MOUNT_THUMB_CACHE) {
      const oldest = t.keys().next().value;
      if (oldest === undefined) break;
      t.delete(oldest);
    }
  }, []);

  const attach = useCallback(
    (id: string, url: string, decodeHeight: number) => {
      const source = new MediaBunnyFrameSource(url, decodeHeight);
      source.setTelemetryLabel(id);
      // Seed the last-good from a retained thumb (re-mount / scrub-back) so the
      // fresh empty ring HOLDS the prior frame instead of a BLACK flash.
      const carry = retainedThumbs.current.get(id);
      if (carry) {
        source.adoptLastGood(carry);
        retainedThumbs.current.delete(id);
      }
      const unsubscribeFrame = source.onFrame(bumpSnapshot);
      map.current.set(id, { source, url, maxHeight: decodeHeight, unsubscribeFrame });
    },
    [bumpSnapshot],
  );

  const detach = useCallback(
    (id: string, opts?: { retain?: boolean }) => {
      const e = map.current.get(id);
      if (!e) return;
      // Capture the last-good BEFORE dispose (dispose nulls it) so a later
      // re-mount can hold it. dispose() also emits the balanced decoder telemetry.
      if (opts?.retain) retainThumb(id, e.source.lastGoodFrame());
      e.unsubscribeFrame();
      e.source.dispose();
      map.current.delete(id);
    },
    [retainThumb],
  );

  // Attach the near set, dispose the far set, for the given playhead. Idempotent:
  // it only mutates + commits the snapshot on a real mount change (a clip crossing
  // the window boundary), so the steady per-tick path is O(N) set-membership with
  // NO React re-render — preserving the frame-isolation invariant. Uses a WIDER
  // window for the dispose side (hysteresis) so a boundary-parked source can't
  // flap-mount.
  const reconcileMounts = useCallback(
    (playheadSec: number) => {
      const reg = registry.current;
      const clips = clipsRef.current;
      const mountSet = planMountWindow({
        playheadSec,
        clips,
        aheadSec: MOUNT_AHEAD_SEC,
        behindSec: MOUNT_BEHIND_SEC,
      });
      const keepAlive = planMountWindow({
        playheadSec,
        clips,
        aheadSec: MOUNT_AHEAD_SEC + MOUNT_HYSTERESIS_SEC,
        behindSec: MOUNT_BEHIND_SEC + MOUNT_HYSTERESIS_SEC,
      });
      let changed = false;
      // Attach / reattach the near set.
      for (const id of mountSet) {
        const r = reg.get(id);
        if (!r) continue;
        const ex = map.current.get(id);
        if (!ex) {
          attach(id, r.url, r.decodeHeight);
          changed = true;
        } else if (ex.url !== r.url || ex.maxHeight !== r.decodeHeight) {
          // URL / preview-quality / rect-bucket swap: carry the last-good across so
          // the reattach holds the frame instead of flashing black (adoptLastGood).
          retainThumb(id, ex.source.lastGoodFrame());
          detach(id);
          attach(id, r.url, r.decodeHeight);
          changed = true;
        }
      }
      // Dispose the far set (mounted but outside the wider keep-alive window) or
      // any source whose clip left the composition. NEVER disposes an active
      // clip — planMountWindow always includes active (decode-all-active).
      for (const [id] of map.current) {
        if (!reg.has(id)) {
          detach(id);
          retainedThumbs.current.delete(id);
          changed = true;
        } else if (!keepAlive.has(id)) {
          detach(id, { retain: true });
          changed = true;
        }
      }
      if (changed) commitSnapshot();
    },
    [attach, detach, retainThumb, commitSnapshot],
  );

  // Rebuild the registry (id → url + timeline span) whenever the composition or
  // decode-height cap changes, then reconcile mounts for the current playhead
  // (mount the near set, dispose sources whose clip was removed / at a new cap).
  useEffect(() => {
    if (!composition) {
      for (const id of [...map.current.keys()]) detach(id);
      registry.current.clear();
      clipsRef.current = [];
      retainedThumbs.current.clear();
      setSnapshot({});
      return;
    }
    const cap = maxDecodeHeight;
    const reg = new Map<
      string,
      { url: string; startSec: number; endSec: number; decodeHeight: number }
    >();
    // Scenes are canvas-only — they decode no video. Every video source in the
    // composition is an overlay.
    for (const o of composition.overlays ?? []) {
      if (o.kind === "video") {
        // Prefer the hydrated proxy URL (scrub-friendly); fall back to the original.
        // Decode-by-size: a small PIP rect decodes small (quadratic decode/memory
        // win); a full-frame rect lands in the top bucket ⇒ unchanged. Uses the
        // AUTHORED rect height (comp px) so a resize only re-attaches on a bucket
        // crossing, never per drag pixel.
        reg.set(o.id, {
          url: o.videoUrl ?? `/api/files/by-id/${o.fileId}/content`,
          startSec: o.startTime,
          endSec: o.startTime + o.duration,
          decodeHeight: bucketDecodeHeight(o.rect.height, cap),
        });
      } else if (o.kind === "tracked" && o.content.kind === "video") {
        // Tracked video crops a bbox from the full frame — decode at the full cap.
        reg.set(o.id, {
          url: `/api/files/by-id/${o.content.fileId}/content`,
          startSec: o.startTime,
          endSec: o.startTime + o.duration,
          decodeHeight: cap,
        });
      }
    }
    registry.current = reg;
    clipsRef.current = [...reg].map(([id, r]) => ({ id, startSec: r.startSec, endSec: r.endSec }));
    reconcileMounts(frameStore.get() / (composition.fps || 30));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composition, maxDecodeHeight, reconcileMounts, frameStore, detach]);

  // Apply the K-capped active/warm/cold budget every frame + on play/pause.
  //
  // The playhead drives the budget by SUBSCRIBING to the frame store (imperative
  // side-effect), NOT by receiving the frame as a render prop. This is the whole
  // point of the change: applyBudget mutates source play/pause/warm state — it
  // produces no React output — so running it from the store subscription keeps
  // the 30 Hz budget cadence WITHOUT re-rendering this hook's host
  // (preview-surface) and its subtree (the inspector) every frame. Re-subscribes
  // on composition / playing / maxDecodeHeight change (the closure captures them).
  //
  // It reads `map.current` directly, so it does NOT depend on `snapshot`.
  // CRITICAL: `snapshot` must stay OUT of here. `bumpSnapshot` (the decode→repaint
  // signal from a source's onFrame) replaces `snapshot` with a fresh object on
  // every decoded frame; depending on it would spin applyBudget → prime/pump →
  // onFrame → bumpSnapshot → re-run → … in a ~60Hz feedback loop that starves the
  // active decoder (ring underflow → pump restarts → stutter).
  useEffect(() => {
    if (!composition) return;
    const fps = composition.fps || 30;
    const run = () => {
      const playheadSec = frameStore.get() / fps;
      // Proximity mount/dispose FIRST (so applyBudget sees the near set), THEN the
      // active/warm/cold budget. Both are pure side-effects (no React output) —
      // reconcileMounts only re-renders on a real mount change (boundary cross).
      reconcileMounts(playheadSec);
      applyBudget({
        composition,
        playheadSec,
        playing,
        // SourceEntry is a structural superset of BudgetEntry (it carries the
        // idempotency fields applyBudget reads/writes). Map<> is invariant, hence
        // the cast.
        map: map.current as Map<string, BudgetEntry>,
      });
    };
    run(); // apply immediately for the current playhead + on every re-subscribe
    return frameStore.subscribe(run);
    // maxDecodeHeight is a re-attach trigger (read by the OTHER effect, not here);
    // snapshot is deliberately excluded — see the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composition, playing, maxDecodeHeight, frameStore, reconcileMounts]);

  // ── Debounced settle-warm: instant play from a resting pause ───────────────
  // While PAUSED, once the playhead has RESTED for PAUSED_WARM_SETTLE_MS, warm each
  // ACTIVE source so a subsequent play() finds runway ready and the readiness gate
  // releases INSTANTLY. Without this a cold press-play times out at ~MAX_GATE_MS
  // (~1.6s): the pump can't build runway during the gate hold (playing=false
  // there), so the gate waits for runway that never comes. The debounce is the
  // safety vs the scrub "extra frames" artifact — a scrub streams frame changes
  // that keep RESETTING the timer, so warm never fires mid-drag; only ~250ms after
  // the playhead comes to rest (load / scrub-release). No-op while playing.
  useEffect(() => {
    if (!composition || playing) return;
    const fps = composition.fps || 30;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const warmActiveAtRest = () => {
      const playheadSec = frameStore.get() / fps;
      const { clips, geom } = collectVideoGeometry(composition);
      for (const c of clips) {
        if (playheadSec < c.startSec || playheadSec >= c.endSec) continue; // active only
        const entry = map.current.get(c.id);
        const g = geom.get(c.id);
        if (!entry || !g) continue;
        entry.source.warm(sourceLocalTime(g, playheadSec));
      }
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(warmActiveAtRest, PAUSED_WARM_SETTLE_MS);
    };
    schedule(); // warm the current resting position (pause-enter / piece load)
    const unsubscribe = frameStore.subscribe(schedule); // a scrub resets the debounce
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [composition, playing, frameStore]);

  // ── Hard-seek on a discrete USER seek/scrub ───────────────────────────────
  // A user seek/scrub bumps `seekSignal`. Unlike the 30 Hz playback advance
  // (which must stay SOFT so a non-frame-aligned clip start doesn't thrash-
  // restart the pump), a discrete user seek must FLUSH every source's ring and
  // re-decode from the target — otherwise a WARM overlay source replays the
  // frames its pump decoded AHEAD of the in-point (the "extra frames" artifact).
  // applyBudget still runs on the frame-store tick that the seek also triggered,
  // re-establishing the active/warm/cold plan; the hard-seek just guarantees the
  // ring is flushed first so getFrame can't serve a stale ahead-frame.
  useEffect(() => {
    if (!composition || !seekSignal) return;
    // Coalesce a burst of scrub bumps (the ruler fires one per mousemove —
    // 60–120/s on a drag) into ONE hard-seek per animation frame, reading the
    // LATEST scrub frame at flush time. Without this, every pixel of a drag
    // cleared + restarted each source's pump on the same decoder, thrashing it
    // into the ~10-frame scrub "gif". The trailing flush always lands the final
    // (mouseup) position because it reads seekSignal.frame() when it runs.
    let rafId: number | null = null;
    const flush = () => {
      rafId = null;
      hardSeekAllSources(
        composition,
        seekSignal.frame() / (composition.fps || 30),
        map.current,
      );
    };
    const run = () => {
      if (rafId !== null) return; // already scheduled this frame — coalesce
      rafId = requestAnimationFrame(flush);
    };
    const unsubscribe = seekSignal.subscribe(run);
    return () => {
      unsubscribe();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [composition, seekSignal]);

  useEffect(() => {
    const sources = map.current;
    return () => {
      for (const entry of sources.values()) {
        entry.unsubscribeFrame();
        entry.source.dispose();
      }
      sources.clear();
    };
  }, []);

  // errors is retained for API compatibility; the WebCodecs path surfaces decode
  // failures as a placeholder frame + log rather than a typed error map.
  return { sources: snapshot, errors: {} };
}

/**
 * Apply `planSourceBudget`: active scenes play (or, when paused, prime to the
 * playhead so a frame shows), warm scenes decode-ahead from their in-point, cold
 * scenes pause. Scenes work in source-local time (trim.start + offset into the
 * scene); overlays in their own local time.
 *
 * **Idempotent.** It runs on EVERY frame-store tick, so it must not re-issue the
 * same decode action each tick — that per-tick `warm()`/`pause()`/`prime()` churn
 * re-seeded/cleared the decoder ring (the measured "empty: N" pump restarts on a
 * scene that should decode trivially). Each source carries its `lastEffective`
 * action; a transition method fires only when the effective state actually
 * changes. The one deliberate exception is the active-PLAYING `play()`, which is
 * called each tick on purpose: `play()` → `ensureCovers(lastRequestedT)` is how
 * the pump tracks the playhead across seeks, and it is a cheap no-op when the
 * ring already covers the time (it never clears a healthy ring). Paused-scrub
 * `prime()` is de-duped on the primed time so a static pause doesn't re-decode.
 */
/** Per-source timeline geometry: where on the COMPOSITION timeline the source's
 *  clip starts, and the source-local in-point (trim.start) at that boundary. */
interface SourceGeom {
  startSec: number;
  inPointSec: number;
}

/**
 * Collect the video clips + per-source geometry of a composition (base video
 * scenes + video / tracked-video overlays), in the SAME order/semantics the
 * budget uses. Pure — shared by `applyBudget` and the hard-seek wiring so both
 * map a composition playhead to the same source-local time.
 */
function collectVideoGeometry(composition: Composition): {
  clips: BudgetClip[];
  geom: Map<string, SourceGeom>;
} {
  const clips: BudgetClip[] = [];
  const geom = new Map<string, SourceGeom>();
  for (const o of composition.overlays ?? []) {
    if (o.kind === "video") {
      clips.push({ id: o.id, startSec: o.startTime, endSec: o.startTime + o.duration });
      // inPoint = trim.start so warm()/prime()/hard-seek decode the SAME source-time
      // the renderer draws (globalTime - startTime + trim.start). Ignoring trim
      // warmed source-time 0 for a CUT clip → the warmed frames were the wrong part
      // of the video → the clip STILL cold-started at its real in-point on
      // activation (the mid-play buffer at a cut).
      geom.set(o.id, { startSec: o.startTime, inPointSec: o.trim?.start ?? 0 });
    } else if (o.kind === "tracked" && o.content.kind === "video") {
      clips.push({ id: o.id, startSec: o.startTime, endSec: o.startTime + o.duration });
      // Tracked-video draws at absolute global time (no trim); local mapping unchanged.
      geom.set(o.id, { startSec: o.startTime, inPointSec: 0 });
    }
  }
  return { clips, geom };
}

/** Map a composition-second playhead to a source's local decode time, given its
 *  geometry. Mirrors `applyBudget`'s `localAtPlayhead`. */
function sourceLocalTime(g: SourceGeom, playheadSec: number): number {
  return Math.max(g.inPointSec, g.inPointSec + (playheadSec - g.startSec));
}

/** The minimal surface the hard-seek wiring drives. `hardSeek` is preferred
 *  (flush + re-decode bypassing tolerance); `seek` is the soft fallback for a
 *  source without a decode-ahead ring. Declared structurally so the logic is
 *  unit-testable with a fake source. */
export interface HardSeekSource {
  hardSeek?(t: number): void;
  seek(t: number): void;
}

/**
 * HARD-seek every mounted source to its source-local time at composition-second
 * `playheadSec` (a discrete user seek/scrub). Prefers `hardSeek` (flush stale
 * warm/ahead frames); falls back to the soft `seek` when a source lacks it.
 * Pure given its inputs — the React effect just supplies the live map.
 */
export function hardSeekAllSources(
  composition: Composition,
  playheadSec: number,
  map: Map<string, { source: HardSeekSource }>,
): void {
  const { geom } = collectVideoGeometry(composition);
  for (const [id, entry] of map) {
    const g = geom.get(id);
    const localT = g ? sourceLocalTime(g, playheadSec) : 0;
    if (entry.source.hardSeek) entry.source.hardSeek(localT);
    else entry.source.seek(localT);
  }
}

export function applyBudget(args: {
  composition: Composition;
  playheadSec: number;
  playing: boolean;
  map: Map<string, BudgetEntry>;
}): void {
  const { composition, playheadSec, playing, map } = args;

  const { clips, geom } = collectVideoGeometry(composition);

  const plan = planSourceBudget({
    playheadSec,
    clips,
    k: SOURCE_BUDGET_K,
    warmAheadSec: WARM_AHEAD_SEC,
  });

  for (const [id, entry] of map) {
    const state: SourceState = plan.get(id) ?? "cold";
    const g = geom.get(id);
    const localAtPlayhead = g ? sourceLocalTime(g, playheadSec) : 0;
    const localInPoint = g?.inPointSec ?? 0;

    if (state === "active") {
      if (playing) {
        // play() EVERY tick on purpose: ensureCovers(lastRequestedT) lets the pump
        // track the playhead across seeks and is a cheap no-op when the ring
        // already covers it (never clears a healthy ring). See the doc comment.
        entry.source.play();
        entry.lastEffective = "active-playing";
      } else {
        // Paused on-screen source: repaint the EXACT frame (prime) ONLY — never a
        // forward runway here. A runway on the displayed source mid-scrub is the
        // seek/scrub "extra frames" artifact. Building runway for an instant play
        // is done by the DEBOUNCED settle-warm effect below (only after the
        // playhead RESTS), which can distinguish a settle from a scrub — applyBudget
        // (frame-driven) cannot. Only on ENTER-paused or a playhead MOVE (scrub) —
        // never every tick on a STATIC pause.
        const enteredPaused = entry.lastEffective !== "active-paused";
        const moved =
          entry.lastPrimedLocal === undefined ||
          Math.abs(entry.lastPrimedLocal - localAtPlayhead) > 1e-3;
        if (enteredPaused || moved) {
          void entry.source.prime(localAtPlayhead);
          entry.lastPrimedLocal = localAtPlayhead;
        }
        entry.lastEffective = "active-paused";
      }
    } else if (state === "warm") {
      // Warm once on transition; the pump fills ~LOOKAHEAD then parks. Re-issuing
      // warm() every tick re-runs ensureCovers and risks a needless restart.
      if (entry.lastEffective !== "warm") {
        entry.source.warm(localInPoint);
        entry.lastEffective = "warm";
      }
    } else {
      // Cold once on transition; pause() aborts the pump (ring kept). Re-pausing a
      // steady cold source every tick is wasted work.
      if (entry.lastEffective !== "cold") {
        entry.source.pause();
        entry.lastEffective = "cold";
        entry.lastPrimedLocal = undefined;
      }
    }
  }
}
