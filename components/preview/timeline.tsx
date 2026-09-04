"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Film,
  Volume2,
  Type,
  Shapes,
  Image as ImageIcon,
  Target,
  Layers,
  Plus,
  Link2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AudioClip, Composition, Overlay, TextOverlay } from "@/lib/engine/types";
import TimelineAudioSection from "./timeline-audio-section";
import { CoupledAudioStrip } from "./coupled-audio-strip";
import { DetachedAudioTrack } from "./detached-audio-track";
import { orderForVerticalDrop, type StackOrderRow } from "@/lib/preview/audio-clip-drag";
import { useReactRenderTelemetry } from "@/lib/preview/telemetry";
import { frameToTimecode } from "@/lib/preview/timecode";
import type { FrameStore } from "@/lib/preview/frame-store";
import { usePlaybackFrame } from "@/hooks/preview/use-playback-frame";
import type { SelectionStore } from "@/lib/preview/selection-store";
import { useSelectedOverlay, useSelectedOverlayIds } from "@/hooks/preview/use-selected-overlay";
import { resolveSelection, type SelectionModifiers } from "@/lib/preview/selection-logic";
import {
  buildTrackStackViewModel,
  crossRowDeltaFromY,
  rowHeightForKind,
  TRACK_H_SHORT,
} from "@/lib/preview/track-stack-view-model";
import { TimelineOverlayRow } from "@/components/preview/timeline-overlay-row";
import { TimelinePlayheadStrip } from "@/components/preview/timeline-playhead-strip";
import TimelineZoomControls from "@/components/preview/timeline-zoom-controls";
import { usePlayheadScrub } from "@/hooks/preview/use-playhead-scrub";
import { TrackRail, RAIL_WIDTH } from "@/components/preview/track-rail";
import type { LaneView } from "@/lib/preview/lane-bar-geometry";
import { useEditorState } from "@/lib/editor-state-context";
import {
  contentWidth as zoomContentWidth,
  fitPxPerSec,
  applyWheelZoom,
  anchoredScrollLeft,
  maxPxPerSec,
} from "@/lib/preview/timeline-zoom";
import {
  followScrollLeft,
  edgeScrollDelta,
  zoomAnchorX,
  maxScrollLeft,
  type FollowView,
} from "@/lib/preview/playhead-follow";
import { AddOverlayMenu } from "@/components/preview/add-overlay-menu";
import { overlayKeyframeTimes } from "@/lib/overlays/keyframes";
import type { NewOverlayPayload, NewOverlayCtx } from "@/lib/overlays/new-overlay-defaults";
import { LIBI_FILE_MIME, decodeFileDrag } from "@/lib/preview/drag-payload";
import { resolveTimelineDropTarget, type TimelineDropZone } from "@/lib/preview/timeline-drop-target";
import { useFilmstripStatuses } from "@/lib/queries/filmstrips";
import { distributeTrackHeights, rowSizing } from "@/lib/preview/track-heights";
import {
  buildMediaById,
  distinctVideoFileIds,
  resolveMediaPaint,
  type MediaPaint,
} from "@/lib/preview/timeline-media";

interface TimelineProps {
  totalFrames: number;
  frameStore: FrameStore;
  fps: number;
  onFrameChange: (frame: number) => void;
  composition: Composition | null;
  audioClips?: AudioClip[];
  onToggleClipEnabled?: (clipId: string) => void;
  onClipContextMenu?: (clipId: string, x: number, y: number) => void;
  onOverlayContextMenu?: (overlayId: string, x: number, y: number) => void;
  markers?: { time: number; id: string }[];
  onMarkerClick?: (time: number) => void;
  overlays?: Overlay[];
  /** Precomputed overlayId → bar label (kind + display name / content / file
   *  name), built where file records are available. When omitted, the timeline
   *  falls back to a text-content-only label. */
  labelById?: Record<string, string>;
  /** Precomputed overlayId → rich rail-icon tooltip (full name + attached note). */
  railTooltipById?: Record<string, string>;
  selectionStore: SelectionStore;
  isOverlayLocked: (id: string) => boolean;
  collapsedGroups: Record<string, boolean>;
  onToggleRowCollapsed: (group: string) => void;
  onCommitOverlayTiming: (id: string, timing: { startTime: number; duration: number }) => void;
  onCrossRowOverlay: (id: string, deltaRows: number) => void;
  /** Add-overlay picker wiring (owned by PreviewSurface's create host). */
  pieceId: string;
  resolveCtx: () => Omit<NewOverlayCtx, "fileId" | "group">;
  onCreateDirect: (payload: NewOverlayPayload) => void;
  onPickAsset: (kind: "image" | "video") => void;
  onAskAgent: (kind: "code" | "three" | "tracked") => void;
  /** Lane drop-create wiring (in-app asset + OS file → image/video overlay). */
  durationSec?: number;
  frameSize?: { width: number; height: number };
  onDropCreate?: (args: {
    kind: "image" | "video";
    fileId: string;
    startTime: number;
    z: number;
    group?: string;
  }) => void;
  onDropFiles?: (
    file: File,
    resolved: { kind: "image" | "video"; startTime: number; z: number; group?: string },
  ) => void;
  /** Drop AUDIO onto the timeline → a standalone audio clip. `fileId` for an
   *  in-app asset, `file` for an OS drop (uploaded first). */
  onDropAudio?: (arg: { fileId?: string; file?: File; startTime: number }) => void;
  /** Overlay id just created (from a drop/add) — plays a one-shot enter
   *  animation on its bar, then clears. */
  justAddedId?: string | null;
  /** Detach a video overlay's coupled inline audio (→ standalone track). */
  onDetachAudio?: (clipId: string) => void;
  /** Re-attach a detached clip to its video overlay (→ coupled again). */
  onRelinkAudio?: (clipId: string, overlayId: string) => void;
  /** Commit a standalone/detached clip's own timing (independent drag). */
  onCommitClipTiming?: (clipId: string, timing: { startTime: number; duration: number }) => void;
  /** Commit a DETACHED audio track's timing AND/OR vertical placement
   *  (`timelineOrder`) in ONE patch — a detached drag is horizontal + vertical. */
  onCommitDetachedTrack?: (
    clipId: string,
    patch: { startTime: number; duration: number; timelineOrder?: number },
  ) => void;
  /** The currently-selected keyframe `{ overlayId, t }`, or null (drives the
   *  diamond highlight). */
  selectedKeyframe?: { overlayId: string; t: number } | null;
  /** Click a keyframe diamond → select it (+ its overlay). */
  onSelectKeyframe?: (overlayId: string, t: number) => void;
  /** Right-click a keyframe diamond → open the keyframe-scoped menu. */
  onKeyframeContextMenu?: (overlayId: string, t: number, x: number, y: number) => void;
}

/** The track-stack's vertical `gap-1` in px — fed to distributeTrackHeights so
 *  rows + gaps fill the measured stack height exactly. */
const STACK_GAP_PX = 4;

/** Height (px) of a video overlay's coupled audio strip (slim — it's attached,
 *  not a full track). */
const COUPLED_AUDIO_STRIP_H = 16;

const KIND_LUCIDE: Record<Overlay["kind"], LucideIcon> = {
  text: Type,
  image: ImageIcon,
  video: Film,
  code: Shapes,
  three: Shapes,
  tracked: Target,
};
/** Per-overlay-row rail icon, by the overlay's content kind. */
function overlayKindIcon(kind: Overlay["kind"]): LucideIcon {
  return KIND_LUCIDE[kind] ?? Layers;
}
/** Short, human label for a single overlay row, by kind. */
function overlayKindLabel(kind: Overlay["kind"]): string {
  switch (kind) {
    case "text":
      return "Text";
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "code":
      return "Code";
    case "three":
      return "3D";
    case "tracked":
      return "Tracked";
  }
}

// The ruler/transport timecode is `frameToTimecode` (shared with the ask-agent
// composer so the prompt's timestamp matches the selector exactly).
const formatTime = frameToTimecode;

function Timeline({
  totalFrames,
  frameStore,
  fps,
  onFrameChange,
  composition,
  audioClips,
  onToggleClipEnabled,
  onClipContextMenu,
  onOverlayContextMenu,
  markers,
  onMarkerClick,
  overlays,
  labelById: labelByIdProp,
  railTooltipById,
  selectionStore,
  isOverlayLocked,
  collapsedGroups,
  onToggleRowCollapsed,
  onCommitOverlayTiming,
  onCrossRowOverlay,
  pieceId,
  resolveCtx,
  onCreateDirect,
  onPickAsset,
  onAskAgent,
  durationSec,
  frameSize,
  onDropCreate,
  onDropFiles,
  onDropAudio,
  justAddedId,
  onDetachAudio,
  onRelinkAudio,
  onCommitClipTiming,
  onCommitDetachedTrack,
  selectedKeyframe,
  onSelectKeyframe,
  onKeyframeContextMenu,
}: TimelineProps) {
  useReactRenderTelemetry("Timeline");
  const { viewMode, previewTimelineZoom, setPreviewTimelineZoom } = useEditorState();
  const rawFrame = usePlaybackFrame(frameStore);
  const currentFrame = totalFrames > 0 ? Math.min(rawFrame, totalFrames - 1) : 0;
  const selectedId = useSelectedOverlay(selectionStore);
  const selectedIds = useSelectedOverlayIds(selectionStore);
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  // Measure the VISIBLE (post-rail) viewport width of the horizontal scroll
  // container so we can compute the fit zoom. The content width is decoupled
  // from this — it grows with zoom while the viewport stays fixed.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect.width ?? 0);
      setViewportWidth(Math.max(0, w - RAIL_WIDTH));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Measure the track-stack container's height so the rows can stretch to fill
  // the bottom timeline panel (Plan-D vertical stretch). Independent of the
  // horizontal viewport observer above so width/height stay decoupled.
  const stackRef = useRef<HTMLDivElement>(null);
  const [stackHeight, setStackHeight] = useState(0);
  // Full content height of the stack INCLUDING rows that overflow the flex-1 box
  // (so the spanning playhead covers every track, not just the visible viewport).
  const [stackContentHeight, setStackContentHeight] = useState(0);
  useEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = Math.floor(entries[0]?.contentRect.height ?? 0);
      setStackHeight(Math.max(0, h));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totalSeconds = totalFrames > 0 && fps > 0 ? totalFrames / fps : 0;
  // The zoom ceiling is frame-derived (MAX_PX_PER_FRAME × fps), so it depends
  // only on this composition's frame rate — memoize on fps alone rather than
  // recomputing on every render.
  const maxPx = useMemo(() => maxPxPerSec(fps), [fps]);
  // Clamp the stored zoom up to fit so a short comp never renders narrower than
  // its viewport. fitPxPerSec already floors to ZOOM_MIN on a degenerate view.
  const fitPx = fitPxPerSec(viewportWidth, totalSeconds);
  const pxPerSec = Math.max(previewTimelineZoom ?? fitPx, fitPx);
  const cw = zoomContentWidth(pxPerSec, totalSeconds);
  // At/below Fit, contentWidth can float to viewport + ε → a phantom 1px
  // horizontal scrollbar. Pin the render width to the measured viewport and
  // disable horizontal overflow whenever we're at Fit (fit is the floor).
  const atFit = pxPerSec <= fitPx + 0.5;
  const renderWidth = atFit ? viewportWidth : cw;

  // Anchored wheel zoom: the scrollLeft that keeps the time under the cursor
  // fixed must be applied AFTER the content width updates. The wheel handler
  // stashes a pending anchor; this layout effect applies it once cw reflects
  // the new pxPerSec.
  const pendingAnchorRef = useRef<number | null>(null);
  // Read live derivations inside the imperative wheel handler without
  // re-binding. Written in a layout effect (never during render) so they are
  // current before any wheel event can fire against the committed DOM.
  const pxPerSecRef = useRef(pxPerSec);
  const totalSecondsRef = useRef(totalSeconds);
  const maxPxRef = useRef(maxPx);
  const setZoomRef = useRef(setPreviewTimelineZoom);
  useLayoutEffect(() => {
    pxPerSecRef.current = pxPerSec;
    totalSecondsRef.current = totalSeconds;
    maxPxRef.current = maxPx;
    setZoomRef.current = setPreviewTimelineZoom;
  });

  // useLayoutEffect (not useEffect) so the anchored scrollLeft is applied in the
  // same paint as the post-zoom width change — no sub-frame horizontal flicker
  // during a fast Cmd/Ctrl-wheel zoom.
  useLayoutEffect(() => {
    if (pendingAnchorRef.current != null && scrollRef.current) {
      scrollRef.current.scrollLeft = pendingAnchorRef.current;
      pendingAnchorRef.current = null;
    }
    // Re-run whenever the content width changes (cw is the post-zoom width).
  }, [cw]);

  // Non-passive wheel listener: React onWheel is passive and can't
  // preventDefault. Cmd/Ctrl+wheel zooms anchored at the cursor; plain wheel is
  // left to native scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return; // plain wheel → native scroll
      e.preventDefault();
      const oldPx = pxPerSecRef.current;
      if (oldPx <= 0 || totalSecondsRef.current <= 0) return;
      const newPx = applyWheelZoom({
        pxPerSec: oldPx,
        factor: e.deltaY < 0 ? 1.1 : 1 / 1.1,
        maxPx: maxPxRef.current,
      });
      if (newPx === oldPx) return;
      const rect = el.getBoundingClientRect();
      const pointerX = e.clientX - rect.left - RAIL_WIDTH;
      pendingAnchorRef.current = anchoredScrollLeft({
        pointerX,
        prevScrollLeft: el.scrollLeft,
        oldPxPerSec: oldPx,
        newPxPerSec: newPx,
      });
      setZoomRef.current(newPx);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const handleZoomFit = () => setPreviewTimelineZoom(null);

  // Opening a different piece starts at Fit. Zoom is absolute px-per-second, so
  // carrying one piece's zoom into another shows an arbitrary slice of a
  // composition with an unrelated duration.
  useEffect(() => {
    setPreviewTimelineZoom(null);
  }, [pieceId, setPreviewTimelineZoom]);

  // Shift+Z re-fits the whole composition (CapCut's "adapt to timeline"). Bare
  // Shift+Z is free: the two other `z` bindings in the editor — discard-draft in
  // snapshot-draft-switcher.tsx and revert-reanchor in preview-player.tsx — both
  // require Cmd/Ctrl and return early without it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "z" && e.key !== "Z") return;
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      setPreviewTimelineZoom(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setPreviewTimelineZoom]);

  const playheadPercent = totalFrames > 0 ? (currentFrame / (totalFrames - 1)) * 100 : 0;

  const overlayList = overlays ?? [];
  const stackVM = useMemo(
    () =>
      buildTrackStackViewModel(composition, {
        selectedIds: selectedIdSet,
        // Hidden is the persisted overlay field (the eye toggle) — read it
        // straight off the overlay, no editor-state lookup.
        hidden: Object.fromEntries(
          overlayList.filter((o) => o.hidden === true).map((o) => [o.id, true]),
        ),
        locked: Object.fromEntries(
          overlayList.filter((o) => isOverlayLocked(o.id)).map((o) => [o.id, true]),
        ),
      }),
    [composition, selectedIdSet, overlayList, isOverlayLocked],
  );

  // Per-overlay rows (Issue 3 refinement) have a FIXED, kind-based height:
  // media (image/video) → TALL filmstrip rows, text/code/three → SHORT labeled
  // bars, audio → SHORT. Every row reports weight 0, so none of them grow to
  // absorb leftover panel space. distributeTrackHeights still runs so the keyed
  // map (used by each row below) stays the single source of row heights.
  const rowHeights = useMemo(() => {
    const sizings = stackVM.rows.map((r) => {
      if (r.kind === "overlay") {
        return { id: `ov-${r.overlayId}`, minHeight: rowHeightForKind(r.overlayKind), weight: 0 };
      }
      if (r.kind === "coupledAudio") {
        // Slim strip attached under its video — fixed, never grows.
        return { id: `coupled-${r.clipId}`, minHeight: COUPLED_AUDIO_STRIP_H, weight: 0 };
      }
      if (r.kind === "audioTrack") {
        // Independent detached track — SHORT, fixed (matches a text/audio row).
        return { id: `track-${r.clipId}`, minHeight: TRACK_H_SHORT, weight: 0 };
      }
      // SHORT, fixed (weight 0); keep the multi-clip stacking floor so a
      // many-clip audio row never overflows its allotment.
      const base = rowSizing(r);
      return { id: base.id, minHeight: Math.max(TRACK_H_SHORT, base.minHeight), weight: 0 };
    });
    return distributeTrackHeights({
      rows: sizings,
      available: stackHeight,
      gap: STACK_GAP_PX,
    });
  }, [stackVM.rows, stackHeight]);

  // Measure the ACTUAL extent of the track rows (bottom of the last in-flow row),
  // so the spanning playhead covers exactly the tracks — not the empty space below
  // them when the rows don't fill the panel (scrollHeight would clamp up to the
  // viewport box and overshoot), nor stop short when they overflow it.
  useLayoutEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    const inFlowRows = (Array.from(el.children) as HTMLElement[]).filter(
      // Skip absolutely-positioned children (the playhead + drop indicator).
      (child) => getComputedStyle(child).position !== "absolute",
    );
    // ResizeObserver delivers an initial measurement on observe() and again on
    // any row resize — the setState happens in ITS callback (async wrt this
    // effect), not synchronously in the effect body.
    const ro = new ResizeObserver(() => {
      let maxBottom = 0;
      for (const child of inFlowRows) {
        maxBottom = Math.max(maxBottom, child.offsetTop + child.offsetHeight);
      }
      setStackContentHeight(maxBottom);
    });
    for (const child of inFlowRows) ro.observe(child);
    return () => ro.disconnect();
  }, [rowHeights, stackHeight, stackVM.rows]);

  // ── Playhead (strip + pin + spanning line) ────────────────────────────────
  // One lane element (owned by the strip) defines the x-origin all three
  // scrub surfaces share; one dragging flag drives the timecode chip and a
  // select-none guard while any of them is active.
  const playheadLaneRef = useRef<HTMLDivElement>(null);
  const [playheadDragging, setPlayheadDragging] = useState(false);
  // Latest pointer x while the playhead is being dragged — the edge auto-scroll
  // re-scrubs from it after each scroll step.
  const dragPointerXRef = useRef<number | null>(null);
  // Shared by BOTH scrub surfaces (the spanning line below, and the strip's
  // own usePlayheadScrub inside TimelinePlayheadStrip) — whichever the user
  // actually drags must populate this ref, or the edge-scroll loop below
  // reads a permanently-null clientX and never scrolls for that surface.
  const handleDragPointerX = useCallback((x: number) => {
    dragPointerXRef.current = x;
  }, []);

  // Shared dedupe-guard: passed to BOTH this line's `usePlayheadScrub` call
  // and the strip's (via the `getLastFrame`/`setLastFrame` props below). The
  // edge-scroll rAF loop further down always re-scrubs through the LINE's
  // `scrubTo`, even when the drag actually started on the strip — sharing
  // this state (instead of each instance keeping its own) is what makes that
  // safe: either instance's `scrub` sees the other's last emitted frame, so a
  // re-scrub through the "wrong" instance can't duplicate a seek the right
  // one already made, and can't refuse a genuinely new one either.
  //
  // A get/set FUNCTION pair, not a shared ref object: the ref itself is owned
  // and mutated only here, where it's created — handing it to ANOTHER hook
  // call to mutate directly is what the React Compiler's ref-safety analysis
  // rejects (writing `.current` on a value that arrived as a hook argument).
  const playheadLastFrameRef = useRef<number | null>(null);
  const getPlayheadLastFrame = useCallback(() => playheadLastFrameRef.current, []);
  const setPlayheadLastFrame = useCallback((frame: number | null) => {
    playheadLastFrameRef.current = frame;
  }, []);

  // `scrubTo` isn't a DOM prop — pulled out here so only the four pointer
  // handlers get spread onto the playhead line element below.
  const { scrubTo: lineScrubTo, ...lineScrubHandlers } = usePlayheadScrub({
    laneRef: playheadLaneRef,
    totalFrames,
    onScrub: onFrameChange,
    onDraggingChange: setPlayheadDragging,
    onDragPointerX: handleDragPointerX,
    getLastFrame: getPlayheadLastFrame,
    setLastFrame: setPlayheadLastFrame,
  });

  // The lane's live scroll geometry, in post-rail lane px. Read from the DOM at
  // call time (never stored) so it is correct mid-scroll and mid-zoom.
  const readFollowView = useCallback((): FollowView | null => {
    const el = scrollRef.current;
    if (!el || renderWidth <= 0 || viewportWidth <= 0) return null;
    return {
      playheadX: (playheadPercent / 100) * renderWidth,
      scrollLeft: el.scrollLeft,
      viewportWidth,
      contentWidth: renderWidth,
    };
  }, [renderWidth, viewportWidth, playheadPercent]);

  const handleZoomTo = useCallback(
    (next: number) => {
      // Same no-op guard as the wheel handler below: at either zoom extreme,
      // a control that clamps to the current value (e.g. zoom-in already at
      // the frame-derived ceiling `maxPx`) must not arm a pending anchor that
      // no later `[cw]` width change will ever consume.
      if (Math.max(next, fitPx) === pxPerSec) return;
      const el = scrollRef.current;
      const view = readFollowView();
      if (el && view && pxPerSec > 0) {
        pendingAnchorRef.current = anchoredScrollLeft({
          pointerX: zoomAnchorX(view),
          prevScrollLeft: el.scrollLeft,
          oldPxPerSec: pxPerSec,
          newPxPerSec: next,
        });
      }
      setPreviewTimelineZoom(next);
    },
    [pxPerSec, fitPx, readFollowView, setPreviewTimelineZoom],
  );

  // Follow the playhead: whenever the frame changes and the playhead is off
  // screen, scroll it back into view. Keyed on the FRAME, so a manual scroll
  // while paused moves nothing and is never fought — but during playback the
  // playhead can never be lost. Suppressed mid-drag, where the edge auto-scroll
  // below owns the scroll instead.
  //
  // readFollowView also changes identity on a pure ZOOM (renderWidth moves),
  // and this effect's deps must include it so a PANEL RESIZE (viewportWidth
  // moves) still re-follows. But naively following on every readFollowView
  // change re-fires this effect right after the `[cw]` layout effect above
  // applies an anchored wheel-zoom scrollLeft — and if the playhead sits
  // outside that anchored window, this effect discarded the anchor and
  // snapped to the playhead instead (a zoom-into-a-far-region regression).
  // These two refs remember the (frame, viewportWidth) this effect last
  // actually considered, so the body below can tell "the zoom changed the
  // content width" apart from "the frame advanced" or "the panel resized" —
  // and only follow for the latter two.
  const lastFollowFrameRef = useRef(currentFrame);
  const lastFollowViewportWidthRef = useRef(viewportWidth);

  // useEffect (not useLayoutEffect): unlike the zoom-anchor effect above, there
  // is no width change to synchronise with here, and this runs on every played
  // frame — keeping this hot path out of the layout phase is deliberate.
  useEffect(() => {
    if (playheadDragging) return;
    const el = scrollRef.current;
    if (!el) return;
    const frameChanged = currentFrame !== lastFollowFrameRef.current;
    const viewportChanged = viewportWidth !== lastFollowViewportWidthRef.current;
    lastFollowFrameRef.current = currentFrame;
    lastFollowViewportWidthRef.current = viewportWidth;
    if (!frameChanged && !viewportChanged) return; // zoom-only change — don't fight the anchor
    const view = readFollowView();
    if (!view) return;
    const next = followScrollLeft(view);
    if (next !== null) el.scrollLeft = next;
  }, [currentFrame, playheadDragging, readFollowView, viewportWidth]);

  // `lineScrubHandlers` (and lineScrubTo with it) is a fresh value every
  // render, so the edge-scroll effect below must not depend on it — doing so
  // would tear down and restart the rAF loop on every frame of the drag. Read
  // the current scrubTo through a ref instead (same latest-ref pattern as the
  // wheel handler above).
  const scrubToRef = useRef(lineScrubTo);
  useLayoutEffect(() => {
    scrubToRef.current = lineScrubTo;
  });

  // A fresh drag must start with NO known pointer x — otherwise a stale
  // clientX left over from wherever the LAST drag ended keeps driving the
  // edge-scroll loop below (and its re-scrub) until the next pointermove
  // overwrites it. Reproduced: end a drag inside the edge zone, release, then
  // press elsewhere — the loop scrolled the lane and re-seeked to the old
  // position on its own.
  //
  // This reset is its OWN effect, keyed on `playheadDragging` alone, rather
  // than living inline at the top of the edge-scroll effect below (which also
  // depends on viewportWidth/renderWidth). The edge-scroll effect re-arms —
  // teardown then setup — on every width change too, e.g. an editor splitter
  // drag or window resize WHILE a pin is held stationary at the edge; an
  // inline reset there fired on that re-arm as well, wiping a live, still-
  // valid pointer x for a pointer that never moved (so nothing ever
  // repopulated it), silently killing edge auto-scroll for the rest of that
  // drag. Keying this effect on `playheadDragging` only means it fires
  // exclusively on the false→true transition — a genuine drag start.
  useEffect(() => {
    if (playheadDragging) dragPointerXRef.current = null;
  }, [playheadDragging]);

  // Edge auto-scroll: while the playhead drag is held near (or past) a lane
  // edge, scroll that way each frame and re-scrub, so the user can drag beyond
  // the visible range and still see where they are landing.
  useEffect(() => {
    if (!playheadDragging) return;
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const clientX = dragPointerXRef.current;
      if (clientX == null) return;
      const rect = el.getBoundingClientRect();
      const pointerX = clientX - rect.left - RAIL_WIDTH;
      const delta = edgeScrollDelta({ pointerX, viewportWidth });
      if (delta === 0) return;
      // maxScrollLeft only reads contentWidth/viewportWidth, so build the view
      // from this effect's own deps rather than readFollowView() — that also
      // pulls in playheadPercent, which changes every re-scrub and would put
      // readFollowView in this effect's deps, retriggering the teardown this
      // rAF loop exists to avoid (see the scrubToRef comment above).
      const before = el.scrollLeft;
      const max = maxScrollLeft({ playheadX: 0, scrollLeft: 0, viewportWidth, contentWidth: renderWidth });
      el.scrollLeft = Math.max(0, Math.min(max, before + delta));
      // Only re-scrub if the lane actually moved — at either extreme the clamp
      // pins scrollLeft and the frame under the pointer is unchanged.
      if (el.scrollLeft !== before) scrubToRef.current(clientX);
    };
    raf = requestAnimationFrame(tick);
    // No `dragPointerXRef.current = null` here: this cleanup also runs on a
    // mid-drag re-arm (viewportWidth/renderWidth changing while dragging),
    // and nulling unconditionally is exactly what caused the bug the effect
    // above exists to fix. The dedicated drag-start effect above is the only
    // place this ref gets cleared; while not dragging, nothing reads it, so
    // a value left over from the last drag is inert until the next drag
    // start clears it.
    return () => cancelAnimationFrame(raf);
  }, [playheadDragging, viewportWidth, renderWidth]);

  // Cross-row drag → deltaRows from the pointer's real Y against the rendered
  // overlay rows (variable height). Measures the live row rects so the count of
  // rows crossed is exact regardless of per-kind heights. Reads the DOM at drop
  // time (no per-render geometry), so it's a stable callback.
  const resolveCrossRowDelta = useCallback((draggedId: string, clientY: number): number => {
    const container = stackRef.current;
    if (!container) return 0;
    const ordered = Array.from(
      container.querySelectorAll<HTMLElement>("[data-overlay-row-id]"),
    ).map((el) => {
      const rect = el.getBoundingClientRect();
      return { id: el.dataset.overlayRowId ?? "", top: rect.top, bottom: rect.bottom };
    });
    return crossRowDeltaFromY(ordered, draggedId, clientY);
  }, []);

  // rowId → vertical sort key for the SHARED stack axis: overlay rows use their
  // `z`, detached audio tracks use their `order`. Coupled-audio rows are NOT
  // reorder targets (they reorder via their video), so they're excluded. The
  // detached-track vertical drag pairs this with the live row rects to compute a
  // fractional `timelineOrder` for the drop slot.
  const stackKeyByRowId = useMemo(() => {
    const map: Record<string, number> = {};
    for (const r of stackVM.rows) {
      if (r.kind === "overlay") map[r.overlayId] = r.z;
      else if (r.kind === "audioTrack") map[r.clipId] = r.order;
    }
    return map;
  }, [stackVM.rows]);

  // Detached-track vertical drag → a NEW timelineOrder for the drop slot. Reads
  // the live reorder-target row rects ([data-overlay-row-id]) + their sort keys
  // and fractional-indexes between the drop neighbors. Moves ONLY the audio
  // track — never the video.
  const resolveOrderFromPointer = useCallback(
    (clipId: string, clientY: number): number | null => {
      const container = stackRef.current;
      if (!container) return null;
      const rows: StackOrderRow[] = [];
      for (const el of Array.from(
        container.querySelectorAll<HTMLElement>("[data-overlay-row-id]"),
      )) {
        const id = el.dataset.overlayRowId ?? "";
        const key = stackKeyByRowId[id];
        if (key == null) continue;
        const rect = el.getBoundingClientRect();
        rows.push({ id, key, top: rect.top, bottom: rect.bottom });
      }
      return orderForVerticalDrop(rows, clipId, clientY);
    },
    [stackKeyByRowId],
  );

  // Drop-position indicator: a horizontal line in the stack at the row the
  // dragged overlay will land on, shown live while reordering.
  const [dropY, setDropY] = useState<number | null>(null);
  const handleDragHover = useCallback((_id: string, clientY: number) => {
    const container = stackRef.current;
    if (!container) return;
    const crect = container.getBoundingClientRect();
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>("[data-overlay-row-id]"),
    ).map((el) => el.getBoundingClientRect());
    if (!rows.length) return;
    // Same target as crossRowDeltaFromY: first row whose bottom is at/under the
    // pointer; below all → after the last row.
    let y = rows[rows.length - 1].bottom - crect.top;
    for (const r of rows) {
      if (clientY <= r.bottom) {
        y = r.top - crect.top;
        break;
      }
    }
    setDropY(y);
  }, []);
  const handleDragEnd = useCallback(() => setDropY(null), []);

  // ── Drag media onto the timeline (empty-piece + "＋ new track" zones) ───────
  // A file drag (in-app asset via LIBI_FILE_MIME, or OS files) over the timeline
  // body. `dragActive` lights up the zones; the per-lane rows keep their own drop
  // handling (drop on a lane → that lane's z/group). These container zones cover
  // the two cases the lanes can't: an empty piece (no lanes) and adding a NEW
  // lane above the rest.
  const dropZonesEnabled = Boolean(onDropCreate || onDropFiles || onDropAudio);
  const [dragActive, setDragActive] = useState(false);
  const isFileDragEvent = useCallback((e: React.DragEvent): boolean => {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    const list = Array.from(types);
    return list.includes("Files") || list.includes(LIBI_FILE_MIME);
  }, []);
  const maxOverlayZ = useMemo(
    () => (overlayList.length ? Math.max(...overlayList.map((o) => o.z)) : -1),
    [overlayList],
  );
  const handleZoneDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>, zone: TimelineDropZone, contentEl: HTMLElement | null) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      const rect = contentEl?.getBoundingClientRect();
      const contentX = rect ? e.clientX - rect.left : 0;
      const contentWidth = rect?.width ?? 0;
      const dur = durationSec ?? 0;
      const common = { contentX, contentWidth, durationSec: dur, maxZ: maxOverlayZ, zone };
      const raw = e.dataTransfer.getData(LIBI_FILE_MIME);
      const payload = raw ? decodeFileDrag(raw) : null;
      if (payload) {
        const t = resolveTimelineDropTarget({ ...common, contentType: payload.contentType });
        if (t.kind === "audio") onDropAudio?.({ fileId: payload.fileId, startTime: t.startTime });
        else if (t.kind) onDropCreate?.({ kind: t.kind, fileId: payload.fileId, startTime: t.startTime, z: t.z, group: t.group });
        return;
      }
      const file = e.dataTransfer.files?.[0];
      if (file) {
        const t = resolveTimelineDropTarget({ ...common, contentType: file.type });
        if (t.kind === "audio") onDropAudio?.({ file, startTime: t.startTime });
        else if (t.kind) onDropFiles?.(file, { kind: t.kind, startTime: t.startTime, z: t.z, group: t.group });
      }
    },
    [durationSec, maxOverlayZ, onDropCreate, onDropFiles, onDropAudio],
  );
  const handleZoneDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!dropZonesEnabled || !isFileDragEvent(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      if (!dragActive) setDragActive(true);
    },
    [dropZonesEnabled, isFileDragEvent, dragActive],
  );

  // Coupled drag: the live horizontal offset (seconds) of a video+audio group
  // being dragged, so the sibling (audio strip ↔ video bar) moves WITH it during
  // the drag (not just on landing). Either one publishes; the other mirrors.
  const [coupledDrag, setCoupledDrag] = useState<
    { ownerOverlayId: string; deltaSec: number; dy: number } | null
  >(null);
  const handleCoupledDragMove = useCallback(
    (ownerOverlayId: string, deltaSec: number, dy: number) =>
      setCoupledDrag({ ownerOverlayId, deltaSec, dy }),
    [],
  );
  const handleCoupledDragEnd = useCallback(() => setCoupledDrag(null), []);

  const timingById = useMemo(() => {
    const map: Record<string, { startTime: number; duration: number }> = {};
    for (const o of overlayList) map[o.id] = { startTime: o.startTime, duration: o.duration };
    return map;
  }, [overlayList]);
  // overlayId → sorted normalized-t keyframe union (diamonds). Only overlays
  // that actually have keyframes get an entry, so the diamond layer is inert
  // (and allocation-free) for a non-keyframed comp.
  const keyframeTsById = useMemo(() => {
    const map: Record<string, number[]> = {};
    for (const o of overlayList) {
      const ts = overlayKeyframeTimes(o);
      if (ts.length > 0) map[o.id] = ts;
    }
    return map;
  }, [overlayList]);
  // Composition-global playhead time (seconds) — remapped per-bar for the
  // playhead-diamond highlight. Derived from the frame the timeline already
  // subscribes to, so it costs nothing extra.
  const playheadSec = fps > 0 ? currentFrame / fps : 0;
  // Prefer the precomputed labels (kind + display name / file name, built where
  // file records are available); fall back to a text-content-only map.
  const fallbackLabelById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const o of overlayList) {
      if (o.kind === "text") {
        const text = (o as TextOverlay).content;
        if (text) map[o.id] = text;
      }
    }
    return map;
  }, [overlayList]);
  const labelById = labelByIdProp ?? fallbackLabelById;
  const laneView: LaneView = useMemo(
    () => ({ trackWidth: renderWidth, totalFrames, fps }),
    [renderWidth, totalFrames, fps],
  );

  // Media in bars (Plan C): collect the distinct video fileIds ONCE so we make
  // a single centralized filmstrip-status poll (never a hook-per-bar), then
  // resolve each overlay to a CSS background paint.
  const mediaById = useMemo(() => buildMediaById(composition), [composition]);
  const videoFileIds = useMemo(
    () => distinctVideoFileIds(mediaById),
    [mediaById],
  );
  const filmstripStatuses = useFilmstripStatuses(videoFileIds);
  // px-per-second for bar-width-aware sprite geometry (same math as laneBarRect).
  const pxPerSecForPaint = totalSeconds > 0 ? renderWidth / totalSeconds : 0;

  const mediaPaintById = useMemo(() => {
    const map: Record<string, MediaPaint | null> = {};
    for (const o of overlayList) {
      const ref = mediaById.get(o.id);
      if (!ref) continue;
      map[o.id] = resolveMediaPaint({
        ref,
        status:
          ref.kind === "video" ? filmstripStatuses.get(ref.fileId) : undefined,
        barWidthPx: o.duration * pxPerSecForPaint,
      });
    }
    return map;
  }, [overlayList, mediaById, filmstripStatuses, pxPerSecForPaint]);

  const handleSelectOverlay = (id: string, mods?: SelectionModifiers) =>
    selectionStore.setAll(resolveSelection(id, selectionStore.getAll(), mods ?? {}));
  const handleSelectAudioClip = (id: string) => selectionStore.set(id);

  return (
    <div className="flex h-full flex-col gap-2 border-t border-border bg-surface px-4 py-3">
      {/* Time display + add-overlay picker */}
      <div className="flex shrink-0 items-center justify-between">
        <span className="font-mono text-xs text-muted-foreground">{formatTime(currentFrame, fps)}</span>
        <div className="flex items-center gap-2">
          {viewMode !== "snapshot" && (
            <AddOverlayMenu
              resolveCtx={resolveCtx}
              pieceId={pieceId}
              onCreateDirect={onCreateDirect}
              onPickAsset={onPickAsset}
              onAskAgent={onAskAgent}
              trigger={
                <button
                  type="button"
                  className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                >
                  <Plus className="size-3" /> Add
                </button>
              }
            />
          )}
          <TimelineZoomControls
            pxPerSec={pxPerSec}
            fitPx={fitPx}
            maxPx={maxPx}
            onZoom={handleZoomTo}
            onFit={handleZoomFit}
          />
          <span className="font-mono text-xs text-muted-foreground">{formatTime(totalFrames, fps)}</span>
        </div>
      </div>

      {/* One horizontal scroll container holds the ruler + track stack. Content
          width is RAIL_WIDTH + renderWidth (= viewport at Fit so there's no
          h-scrollbar; = cw when zoomed in); the rails are sticky-left so they
          stay pinned while lanes scroll. */}
      <div
        ref={scrollRef}
        data-testid="timeline-scroll"
        className="relative min-h-0 flex-1 overflow-y-auto"
        style={{ overflowX: atFit ? "hidden" : "auto" }}
      >
        <div
          data-testid="timeline-scroll-content"
          className={`flex h-full min-h-0 flex-col${playheadDragging ? " select-none" : ""}`}
          style={{ width: RAIL_WIDTH + renderWidth }}
        >
          {/* Sticky playhead strip — no ruler track. The pin sits on the top
              border of the first track row and stays pinned to the top of
              the visible timeline while the tracks scroll beneath it. */}
          <TimelinePlayheadStrip
            totalFrames={totalFrames}
            playheadPercent={playheadPercent}
            markers={markers ?? []}
            fps={fps}
            currentFrame={currentFrame}
            onScrub={onFrameChange}
            onMarkerClick={onMarkerClick ?? (() => {})}
            contentWidth={renderWidth}
            laneRef={playheadLaneRef}
            dragging={playheadDragging}
            onDraggingChange={setPlayheadDragging}
            onDragPointerX={handleDragPointerX}
            getLastFrame={getPlayheadLastFrame}
            setLastFrame={setPlayheadLastFrame}
          />

          {/* Track stack + single spanning playhead. This is the measured
              element for Plan-D vertical stretch (flex-1 fills the panel). */}
          <div
            ref={stackRef}
            className="relative flex min-h-0 flex-1 flex-col gap-1"
            data-testid="timeline-track-stack"
            onDragOver={
              dropZonesEnabled
                ? (e) => {
                    if (isFileDragEvent(e) && !dragActive) setDragActive(true);
                  }
                : undefined
            }
            onDragLeave={
              dropZonesEnabled
                ? (e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragActive(false);
                  }
                : undefined
            }
          >
            {dropY != null && (
              <div
                data-testid="timeline-drop-indicator"
                className="pointer-events-none absolute left-0 right-0 z-40 h-0.5 -translate-y-1/2 rounded bg-primary shadow-[0_0_6px_var(--color-primary,#6366f1)]"
                style={{ top: dropY }}
              />
            )}

            {/* Empty piece: a full-panel drop zone (no lanes exist yet). Dropping
                here creates the first overlay / audio clip at t=0. */}
            {stackVM.rows.length === 0 && dropZonesEnabled && (
              <div className="flex min-h-0 flex-1 items-stretch">
                <div style={{ width: RAIL_WIDTH }} className="shrink-0" />
                <div
                  data-testid="timeline-empty-dropzone"
                  onDragOver={handleZoneDragOver}
                  onDrop={(e) => handleZoneDrop(e, "empty", e.currentTarget)}
                  className={`m-2 flex flex-1 items-center justify-center rounded-lg border-2 border-dashed transition-colors ${
                    dragActive
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border/60 text-muted-foreground"
                  }`}
                >
                  <span className="pointer-events-none px-4 text-center text-sm font-medium">
                    Drag a video, image, or audio file here to add it to the timeline
                  </span>
                </div>
              </div>
            )}
            {stackVM.rows.map((r) => {
              if (r.kind === "overlay") {
                // One row per overlay: rail shows the overlay's KIND icon/label;
                // the row renders a single bar at its fixed kind-based height.
                return (
                  <div
                    key={`ov-${r.overlayId}`}
                    className="flex items-stretch"
                    data-overlay-row-id={r.overlayId}
                  >
                    <TrackRail
                      icon={overlayKindIcon(r.overlayKind)}
                      label={overlayKindLabel(r.overlayKind)}
                      tooltip={railTooltipById?.[r.overlayId]}
                    />
                    <div className="shrink-0" style={{ width: renderWidth }}>
                      <TimelineOverlayRow
                        row={r.row}
                        timingById={timingById}
                        view={laneView}
                        collapsed={false}
                        rowHeight={rowHeights[`ov-${r.overlayId}`]}
                        onSelect={handleSelectOverlay}
                        onCommitTiming={onCommitOverlayTiming}
                        onCrossRow={onCrossRowOverlay}
                        rowDeltaFromPointer={resolveCrossRowDelta}
                        onDragHover={handleDragHover}
                        onDragEnd={handleDragEnd}
                        onCoupledDragMove={handleCoupledDragMove}
                        onCoupledDragEnd={handleCoupledDragEnd}
                        coupledDrag={coupledDrag}
                        durationSec={durationSec}
                        rowGroup={r.group}
                        rowZ={r.z + 1}
                        frameSize={frameSize}
                        justAddedId={justAddedId}
                        onDropCreate={onDropCreate}
                        onDropFiles={onDropFiles}
                        onSeekFrame={onFrameChange}
                        onOverlayContextMenu={onOverlayContextMenu}
                        labelById={labelById}
                        mediaPaintById={mediaPaintById}
                        keyframeTsById={keyframeTsById}
                        playheadSec={playheadSec}
                        selectedKeyframe={selectedKeyframe}
                        onSelectKeyframe={onSelectKeyframe}
                        onKeyframeContextMenu={onKeyframeContextMenu}
                      />
                    </div>
                  </div>
                );
              }
              if (r.kind === "coupledAudio") {
                const clip = (audioClips ?? []).find((c) => c.id === r.clipId);
                const owner = labelById[r.ownerOverlayId] ?? "video";
                const ownerTiming = timingById[r.ownerOverlayId];
                // COUPLED (inline) only — position by the video's (optimistic)
                // window so the strip tracks the video drag with no snap-back.
                const posStart = ownerTiming?.startTime ?? clip?.startTime ?? 0;
                const posDuration = ownerTiming?.duration ?? clip?.duration ?? 0;
                return (
                  <div key={`coupled-${r.clipId}`} className="flex items-stretch">
                    <TrackRail
                      icon={Link2}
                      label="Audio of video"
                      tooltip={`audio — attached to ${owner}`}
                    />
                    <div className="shrink-0" style={{ width: renderWidth }}>
                      <CoupledAudioStrip
                        clip={clip}
                        ownerOverlayId={r.ownerOverlayId}
                        ownerStartSec={posStart}
                        ownerDurationSec={posDuration}
                        height={rowHeights[`coupled-${r.clipId}`] ?? COUPLED_AUDIO_STRIP_H}
                        fps={fps}
                        totalFrames={totalFrames}
                        trackWidth={renderWidth}
                        label={`audio of video — ${owner}`}
                        selected={selectedId === r.clipId}
                        onSelect={() => handleSelectAudioClip(r.clipId)}
                        onToggleEnabled={() => onToggleClipEnabled?.(r.clipId)}
                        onDetach={() => onDetachAudio?.(r.clipId)}
                        onContextMenu={(x, y) => onClipContextMenu?.(r.clipId, x, y)}
                        onCommitVideoTiming={onCommitOverlayTiming}
                        onCoupledDragMove={handleCoupledDragMove}
                        onCoupledDragEnd={handleCoupledDragEnd}
                        coupledDrag={coupledDrag}
                        rowDeltaFromPointer={resolveCrossRowDelta}
                        onCrossRow={onCrossRowOverlay}
                        onDragHover={handleDragHover}
                        onDragEnd={handleDragEnd}
                      />
                    </div>
                  </div>
                );
              }
              if (r.kind === "audioTrack") {
                const clip = (audioClips ?? []).find((c) => c.id === r.clipId);
                const owner = labelById[r.ownerOverlayId] ?? "video";
                return (
                  <div
                    key={`track-${r.clipId}`}
                    className="flex items-stretch"
                    data-overlay-row-id={r.clipId}
                  >
                    <TrackRail
                      icon={Link2}
                      label="Detached audio"
                      tooltip={`detached audio — independent track (was attached to ${owner})`}
                    />
                    <div className="shrink-0" style={{ width: renderWidth }}>
                      <DetachedAudioTrack
                        clip={clip}
                        ownerOverlayId={r.ownerOverlayId}
                        order={r.order}
                        height={rowHeights[`track-${r.clipId}`] ?? TRACK_H_SHORT}
                        fps={fps}
                        totalFrames={totalFrames}
                        trackWidth={renderWidth}
                        label={`detached audio of video — ${owner}`}
                        selected={selectedId === r.clipId}
                        onSelect={() => handleSelectAudioClip(r.clipId)}
                        onToggleEnabled={() => onToggleClipEnabled?.(r.clipId)}
                        onRelink={() => onRelinkAudio?.(r.clipId, r.ownerOverlayId)}
                        onContextMenu={(x, y) => onClipContextMenu?.(r.clipId, x, y)}
                        onCommit={(clipId, patch) =>
                          onCommitDetachedTrack?.(clipId, patch)
                        }
                        resolveOrderFromPointer={resolveOrderFromPointer}
                        onDragHover={handleDragHover}
                        onDragEnd={handleDragEnd}
                      />
                    </div>
                  </div>
                );
              }
              // audio
              return (
                <div key="audio" className="flex items-stretch">
                  <TrackRail icon={Volume2} label="Audio" tooltip="audio — standalone (not attached)" />
                  <div className="shrink-0" style={{ width: renderWidth }}>
                    <TimelineAudioSection
                      height={rowHeights["audio"]}
                      trackWidth={renderWidth}
                      onCommitClipTiming={onCommitClipTiming}
                      // Free standalone clips only (no remembered video link).
                      // Coupled audio rides under its video; detached audio is an
                      // independent audioTrack row — both above.
                      clips={(audioClips ?? []).filter((c) => r.clipIds.includes(c.id))}
                      fps={fps}
                      currentFrame={currentFrame}
                      totalFrames={totalFrames}
                      selectedId={selectedId}
                      onSelectClip={handleSelectAudioClip}
                      onToggleClipEnabled={onToggleClipEnabled ?? (() => {})}
                      onClipContextMenu={onClipContextMenu ?? (() => {})}
                    />
                  </div>
                </div>
              );
            })}

            {/* "＋ new track" drop zone — appears while a file drag is over the
                timeline. Dropping here places the clip on a NEW lane above the
                rest (z = maxZ + 1). Lets the user pick track order without
                dropping onto an existing lane. */}
            {stackVM.rows.length > 0 && dropZonesEnabled && dragActive && (
              <div className="flex shrink-0 items-stretch" data-testid="timeline-newtrack-zone">
                <div
                  style={{ width: RAIL_WIDTH }}
                  className="flex shrink-0 items-center justify-center gap-1 text-[10px] font-medium text-primary"
                >
                  <Plus className="size-3" /> New track
                </div>
                <div
                  data-testid="timeline-newtrack-dropzone"
                  onDragOver={handleZoneDragOver}
                  onDrop={(e) => handleZoneDrop(e, "newTrack", e.currentTarget)}
                  style={{ width: renderWidth }}
                  className="flex h-9 shrink-0 items-center justify-center rounded border-2 border-dashed border-primary bg-primary/10 text-xs text-primary"
                >
                  <span className="pointer-events-none">Drop here for a new track</span>
                </div>
              </div>
            )}

            {/* One playhead spanning the whole stack, aligned to the lane
                origin. Grabbable: a 13px invisible hit area centered on the
                2px line lets the user drag the line itself to scrub. */}
            {totalFrames > 0 && renderWidth > 0 && (
              <div
                data-testid="timeline-playhead"
                className="group absolute top-0 z-20 w-[13px] -translate-x-1/2 cursor-ew-resize touch-none"
                style={{
                  left: RAIL_WIDTH + (playheadPercent / 100) * renderWidth,
                  // Span exactly the track rows (measured) — covers tracks scrolled
                  // into view without overshooting into empty panel space below them.
                  height: stackContentHeight || undefined,
                  bottom: stackContentHeight ? undefined : 0,
                }}
                {...lineScrubHandlers}
              >
                <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-primary shadow-[0_0_0_1px_rgba(0,0,0,0.35)] group-hover:shadow-[0_0_6px_var(--color-primary,#6366f1)]" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(Timeline);
