"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  Composition,
  DrawContext,
  OverlayRect,
  TextOverlay,
  TrackedOverlay,
} from "@/lib/engine/types";
import { renderFrame } from "@/lib/engine/renderer";
import {
  PREVIEW_SUPERSAMPLE_CAP,
  SUPERSAMPLE_SLOW_FRACTION,
  SUPERSAMPLE_DROP_TICKS,
  SUPERSAMPLE_RECOVER_TICKS,
  SUPERSAMPLE_TICK_MS,
} from "@/lib/preview/tuning";
import {
  initSupersampleState,
  nextSupersample,
  type SupersampleState,
} from "@/lib/preview/supersample-controller";
import type { ThreeOverlayInstance } from "@/lib/engine/three-overlay";
import type { OverlayQuadInstance } from "@/lib/engine/overlay-quad";
import type { ContentBox } from "@/lib/overlays/code-content-fit";
import { Layers, EyeOff } from "lucide-react";
import type {
  VideoFrameSource,
  VideoFrameSourceError,
} from "@/lib/engine/video-frame-source";
import { hitTest, overlaysActiveAt } from "@/lib/engine/overlays";
import { contentBoundsToRectUnclamped, floorContentRect } from "@/lib/engine/three-content-bounds";
import { OverlayEditor } from "@/components/preview/overlay-editor";
import { OverlayErrorBadge } from "@/components/preview/overlay-error-badge";
import MasterVolumeControl from "@/components/preview/master-volume-control";
import { useOverlayTracks } from "@/hooks/preview/use-overlay-tracks";
import { useQueryClient } from "@tanstack/react-query";
import { trackKeys } from "@/lib/queries/tracks";
import { sampleTrack } from "@/lib/tracking/sample";
import {
  sampleTrackedOverlay,
  resolveTrackedSpace,
  trackedClipTime,
  trackBoxToComposition,
  compositionBoxToTrack,
  type TrackedSpace,
} from "@/lib/engine/tracked-space";
import { resolveTrackedRect } from "@/lib/engine/overlay-renderer";
import { offsetFromDrop } from "@/lib/preview/tracked-offset-drag";
import {
  recoverManualBbox,
  manualAnchorId,
  mergeManualAnchorsIntoTrack,
  upsertManualAnchor,
} from "@/lib/tracking/manual-anchors";
import { screenToCompositionPoint } from "@/components/preview/reanchor-drag-math";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ManualAnchor, Track, TrackFit, TrackSmoothing } from "@/lib/tracking/types";
import { ExportDialog } from "@/components/export/export-dialog";
import { ExportSuccessToast } from "@/components/export/export-success-toast";
import { revealFile } from "@/lib/shell/client";
import type { UseExportFlowResult } from "@/hooks/editor/use-export-flow";
import { recordPreviewEvent, useReactRenderTelemetry } from "@/lib/preview/telemetry";
import type { FrameStore } from "@/lib/preview/frame-store";
import { showTransformUi } from "@/lib/preview/transform-ui-gate";
import type { OverlayEditStore } from "@/lib/preview/overlay-edit-store";
import { usePlaybackFrame } from "@/hooks/preview/use-playback-frame";
import type { SelectionStore } from "@/lib/preview/selection-store";
import { useSelectedOverlay } from "@/hooks/preview/use-selected-overlay";
import { EffectsPanel, type EffectsFamily } from "@/components/preview/effects-panel";
import type { EffectHighlightStore } from "@/lib/preview/effect-highlight-store";
import type { EffectPreviewStore } from "@/lib/preview/effect-preview-store";
import type { KeyframeSelectionStore } from "@/lib/preview/keyframe-selection-store";
import { OverlayTransformControls } from "@/components/preview/overlay-transform-controls";
import { TrackedTransformControls } from "@/components/preview/tracked-transform-controls";
import { OverlayHandles } from "@/components/preview/overlay-handles";
import { anchorPointOf } from "@/lib/captions/anchor";
import { overlayCanvasControl } from "@/lib/captions/canvas-control";
import { isOverlayNearEdgeOn } from "@/lib/captions/facing";
import { resolveOverlayTransform, resolveFlip, classifyTransform } from "@/lib/engine/overlay-transform";
import { projectSpatialQuadBboxUnclamped } from "@/lib/engine/overlay-quad-projection";
import { isOverlayIn3dMode } from "@/lib/overlays/three-d-mode";
import { overlayAtPlayhead } from "@/lib/overlays/display-overlay";
import { ThreeGizmoControls } from "@/components/preview/three-gizmo-controls";
import type { OverlayTransformPatch } from "@/hooks/editor/use-overlay-transform-commit";

/** Seconds the user can keep fine-tuning a drag before the re-anchor is
 *  actually committed (POST + seeded re-track). Each new drag resets it. */
const REANCHOR_DEBOUNCE_SECONDS = 5;
/** Screen-pixel movement under which a pointer gesture is a click (just
 *  reveal the tracked object), not a drag (re-anchor). */
const DRAG_THRESHOLD_PX = 4;
/** Hard cap on the "Re-tracking…" indicator in case the server's
 *  completion refresh never arrives (e.g. the route's error path emits no
 *  refresh_query). The indicator self-clears after this. */
const REANCHOR_BUSY_TIMEOUT_MS = 120_000;
/** Minimum on-screen size (CSS px, per side) for a `three` overlay's gizmo box.
 *  The box hugs the projected 3D content; flooring it to this keeps the move body
 *  + resize handles grabbable when the content foreshortens (pitch) or recedes
 *  (depth) to a sliver. Capped at the viewport rect so it never overgrows. */
const GIZMO_MIN_CONTENT_CSS = 64;

/** Stable signature of a track's segment set. Changes when a seeded
 *  re-track upserts/replaces a bounded segment, but NOT when manual anchors
 *  are merged in (the merge maps over existing segments, preserving their
 *  ids/statuses) — so it cleanly distinguishes the post-recompute refetch
 *  from the immediate optimistic invalidate. */
function trackSegmentsSig(
  t: { segments?: { id: string; status: string }[] } | undefined,
): string {
  return (t?.segments ?? []).map((s) => `${s.id}:${s.status}`).sort().join("|");
}

interface PreviewPlayerProps {
  composition: Composition | null;
  /** Playhead frame store — owned by the transport. PreviewPlayer subscribes to
   *  it directly so the 30 Hz advance re-renders ONLY the canvas, not the page. */
  frameStore: FrameStore;
  /** Inline overlay-edit store — PreviewSurface-owned. The canvas merges its
   *  in-flight patches (both `preview`-phase gesture ticks and `committed`
   *  entries via `getAll()`) before `renderFrame`, and subscribes its repaint to
   *  `editStore.subscribeImperative` (rAF-coalesced internally) so a gesture
   *  repaints WITHOUT a React re-render. Optional. */
  editStore?: OverlayEditStore;
  /** Playback state — owned by the transport */
  playing: boolean;
  /**
   * True while the readiness gate is holding (the user pressed play but the
   * imminent window isn't decoded yet). Drives the buffering indicator; the
   * playhead is frozen during this state. Optional — absent ⇒ never shown.
   */
  buffering?: boolean;
  /** Called when the user clicks the play/pause button */
  onPlayToggle: () => void;
  /** Current speed multiplier */
  speed: number;
  /** Called when the user changes speed */
  onSpeedChange: (speed: number) => void;
  /** Video frame sources keyed by scene id (from useVideoSources) */
  videoSources: Record<string, VideoFrameSource>;
  /** Load errors keyed by scene.id or overlay.id — surfaces as a warning banner. */
  videoErrors?: Record<string, VideoFrameSourceError>;
  /** Image elements for image overlays, keyed by overlay.id */
  images?: Record<string, HTMLImageElement>;
  /** Compiled draw functions for code overlays, keyed by overlay.id */
  compiledDrawFns?: Record<string, (ctx: DrawContext) => void>;
  /** Probed content ink-bboxes for code overlays, keyed by overlay.id — drives
   *  the renderer's contain-fit of drawn content into the overlay rect. */
  codeContentBoxes?: Record<string, ContentBox | null>;
  /** Three.js overlay instances, keyed by overlay.id */
  threeScenes?: Record<string, ThreeOverlayInstance>;
  /** Spatial (out-of-plane) 2D overlay quad instances, keyed by overlay.id */
  spatialQuads?: Record<string, OverlayQuadInstance>;
  /** Bumps when an uploaded custom font finishes loading — forces a repaint so
   *  a paused preview re-renders text with the now-available family. */
  fontsVersion?: number;
  /** Per-overlay compile/validation errors keyed by overlay.id — drives the
   *  error badge over a code/three overlay whose current source failed. */
  overlayErrors?: Record<string, string>;
  /** Export flow state — drives the modal dialog. */
  exportFlow: UseExportFlowResult;
  /** Piece name for default-filename derivation. */
  pieceName?: string | null;
  /** Whether a committed snapshot exists for the current piece. */
  hasSnapshot?: boolean;
  /** Whether an uncommitted draft exists for the current piece. */
  hasDraft?: boolean;
  /** Called when the user clicks a text overlay */
  onEditOverlay?: (id: string) => void;
  /** The text overlay currently being edited (or null if none). */
  editingOverlay?: TextOverlay | null;
  /** Called when the inline editor commits new content (blur or Enter). */
  onOverlayCommit?: (content: string) => void;
  /** Called when the inline editor cancels (Escape). */
  onOverlayCancel?: () => void;
  /** Total frames — shown in the counter */
  totalFrames: number;
  /** The piece id — required for posting manual anchors to the server. */
  pieceId: string;
  /** Called whenever the selected track's manual anchors change (so the
   *  parent can drive amber tick markers on the Timeline). */
  onSelectedAnchorsChange?: (anchors: { time: number; id: string }[]) => void;
  /** Master volume level (0-1) */
  masterVolume: number;
  /** Whether master audio is muted */
  masterMuted: boolean;
  /** Called when master volume changes */
  onMasterVolumeChange: (v: number) => void;
  /** Called when master mute is toggled */
  onToggleMasterMuted: () => void;
  /** Single-select overlay store — PreviewPlayer subscribes for the selected id. */
  selectionStore: SelectionStore;
  /** Commit a manual overlay transform edit (rect/rotation/...). Called LIVE on
   *  each pointer-move during a gesture so the painted content tracks the drag. */
  onOverlayTransformCommit: (overlayId: string, patch: OverlayTransformPatch) => void;
  /** Force the trailing-debounced PATCH for `overlayId` immediately. Called on
   *  pointer-up so a gesture persists exactly one coalesced PATCH. */
  onOverlayTransformFlush: (overlayId: string) => void;
  /** Returns whether an overlay is editor-locked (suppresses handles + hit). */
  getOverlayLocked: (overlayId: string) => boolean;
  /** Whether the layers panel is docked (controls the toggle button state). */
  layersDocked?: boolean;
  /** Dock/undock the layers + inspector panel. */
  onToggleLayers?: () => void;
  /** Whether the effects picker panel is open (above the controls bar). */
  effectsPanelOpen: boolean;
  /** External "open on this family" request forwarded to the effects panel. */
  familyRequest?: { family: EffectsFamily; nonce: number } | null;
  /** Toggle the effects picker panel. */
  onToggleEffectsPanel: () => void;
  /** Close the effects picker panel. */
  onCloseEffectsPanel: () => void;
  /** Add a keyframe on an overlay at the live playhead (Keyframes-tab button). */
  onAddKeyframeAtPlayhead: (overlayId: string) => void;
  /** Per-surface effect-highlight store — flashes the targeted thumbnail/slot. */
  effectHighlightStore: EffectHighlightStore;
  /** Per-surface effect-preview store — selecting an effect plays its window. */
  effectPreviewStore: EffectPreviewStore;
  /** Selected-keyframe store — drives the Effects panel's Keyframes tab. */
  keyframeSelectionStore: KeyframeSelectionStore;
  /** Snapshot view is read-only — effects tiles are disabled. */
  effectsReadOnly: boolean;
  /** Point-text canvas snapping enabled (frame guides + sibling anchors + angle detents). */
  snapEnabled: boolean;
  /** Toggle point-text snapping (preview toolbar Snap button). */
  onToggleSnap: () => void;
}

export default function PreviewPlayer({
  composition,
  frameStore,
  editStore,
  playing,
  buffering = false,
  onPlayToggle,
  speed,
  onSpeedChange,
  videoSources,
  videoErrors,
  images,
  compiledDrawFns,
  codeContentBoxes,
  threeScenes,
  spatialQuads,
  overlayErrors,
  fontsVersion,
  exportFlow,
  pieceName,
  hasSnapshot = false,
  hasDraft = true,
  onEditOverlay,
  editingOverlay,
  onOverlayCommit,
  onOverlayCancel,
  totalFrames,
  masterVolume,
  masterMuted,
  onMasterVolumeChange,
  onToggleMasterMuted,
  pieceId,
  onSelectedAnchorsChange,
  selectionStore,
  onOverlayTransformCommit,
  onOverlayTransformFlush,
  getOverlayLocked,
  layersDocked = false,
  onToggleLayers,
  effectsPanelOpen,
  familyRequest,
  onToggleEffectsPanel,
  onCloseEffectsPanel,
  onAddKeyframeAtPlayhead,
  effectHighlightStore,
  effectPreviewStore,
  keyframeSelectionStore,
  effectsReadOnly,
  snapEnabled,
  onToggleSnap,
}: PreviewPlayerProps) {
  useReactRenderTelemetry("PreviewPlayer");
  // Clamp to composition bounds — preserves the transport's former
  // `effectiveFrame` guard for when the composition shrinks under a stale
  // playhead. `totalFrames` is already a prop on PreviewPlayer.
  const rawFrame = usePlaybackFrame(frameStore);
  const frame = totalFrames > 0 ? Math.min(rawFrame, totalFrames - 1) : 0;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Last whole-frame render error message, to log it once instead of per-frame.
  const lastRenderErrorRef = useRef<string | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  // ── Preview supersample (crisp overlays on HiDPI) ──────────────────────────
  // The canvas BACKING store is `displaySize × min(devicePixelRatio, cap)` so
  // vector/text/code/3D overlays rasterize at the real screen resolution instead
  // of the fixed logical 1080 (which CSS-upscaled → blur). `renderFrame` reads
  // the backing size and scales the coordinate space; video decode is unchanged
  // (Preview-quality proxy). `effectiveCap` is lowered by the adaptive controller
  // under sustained frame drops and restored with hysteresis.
  const [effectiveCap, setEffectiveCap] = useState(PREVIEW_SUPERSAMPLE_CAP);
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const supersample = Math.min(dpr, effectiveCap);
  // Per-tick dropped-frame accounting for the adaptive controller.
  const superStateRef = useRef<SupersampleState>(initSupersampleState(PREVIEW_SUPERSAMPLE_CAP));
  const frameStatsRef = useRef({ total: 0, slow: 0 });

  // Subscribe to the single-select overlay store + resolve it from the live
  // composition. Only PreviewPlayer (and the layers panel/timeline) re-render
  // on selection — the editor page never reads it. (Distinct from the internal
  // `selectedOverlayId` below, which is the tracked-overlay re-anchor picker.)
  const transformSelectedOverlayId = useSelectedOverlay(selectionStore);
  const transformSelectedOverlay =
    composition?.overlays?.find((o) => o.id === transformSelectedOverlayId) ?? null;
  // Phase 9: the gizmo/handles must frame the value RESOLVED AT THE PLAYHEAD when
  // the overlay is keyframed, not the static base rect/opacity/transform3d.
  // For a NON-keyframed overlay this returns the SAME reference (byte-identical
  // to before — no extra allocation, no behavior change). PreviewPlayer already
  // re-renders per frame (it IS the canvas) and the gizmo only shows while
  // paused, so the pure resolver reads the already-subscribed `frame` — no new
  // subscription needed. Kind / 3D-mode / control-type below intentionally stay
  // on the BASE overlay (those aren't keyframed).
  const transformDisplayOverlay = overlayAtPlayhead(
    transformSelectedOverlay,
    composition && composition.fps > 0 ? frame / composition.fps : 0,
    composition?.fps ?? 30,
  );
  // Whether the selected overlay is a point-text overlay (gets the glyph-box
  // handles + snapping) vs. a generic transform-box overlay.
  const isTextSelected = transformSelectedOverlay?.kind === "text";
  // Which on-canvas control the SELECTED overlay shows, for EVERY kind:
  // "gizmo" when the overlay is in 3D mode (place3d / three / 3D text),
  // else "handles" (its 2D box). A flat overlay never shows the gizmo.
  const canvasControl = transformSelectedOverlay
    ? overlayCanvasControl(transformSelectedOverlay)
    : "handles";
  // Sibling text-overlay anchor points (composition px) — extra snap targets so
  // a dragged caption can align to where another caption is pinned.
  const siblingAnchorsX = useMemo(() => {
    if (!composition || !transformSelectedOverlay) return [] as number[];
    const out: number[] = [];
    for (const o of composition.overlays ?? []) {
      if (o.kind !== "text" || o.id === transformSelectedOverlay.id) continue;
      const a = o.anchor ?? "mid-center";
      const p = o.position ?? anchorPointOf(o.rect, a);
      out.push(p.x);
    }
    return out;
  }, [composition, transformSelectedOverlay]);
  const siblingAnchorsY = useMemo(() => {
    if (!composition || !transformSelectedOverlay) return [] as number[];
    const out: number[] = [];
    for (const o of composition.overlays ?? []) {
      if (o.kind !== "text" || o.id === transformSelectedOverlay.id) continue;
      const a = o.anchor ?? "mid-center";
      const p = o.position ?? anchorPointOf(o.rect, a);
      out.push(p.y);
    }
    return out;
  }, [composition, transformSelectedOverlay]);
  const getCanvasBounds = useCallback(
    () => canvasRef.current?.getBoundingClientRect() ?? null,
    [],
  );

  // Per-3D-mode overlay: the composition-space rect where the overlay's 3D content
  // actually projects, so hitTest + the gizmo box hug the visible content (not the
  // empty base rect). Covers ALL 3D-mode overlays — `three`, 3D-extruded text, and
  // spatial-quad kinds (image/video/code, non-extruded tilted text). Recomputed on
  // edit / resize only (NOT per playback frame) — measuring is a Box3 traversal that
  // must stay off the 30Hz loop.
  const threeContentRects = useMemo(() => {
    const out: Record<string, OverlayRect> = {};
    if (!composition?.overlays || !threeScenes) return out;
    // Floor the projected content box to a grabbable on-screen minimum so the 3D
    // gizmo never collapses to an ungrabbable sliver when the content foreshortens
    // (pitch) or recedes (depth). Convert the CSS-px target to composition px via
    // the live canvas scale so the floor is consistent across resolutions.
    const sx =
      canvasSize.width > 0 && composition.width > 0 ? canvasSize.width / composition.width : 1;
    const sy =
      canvasSize.height > 0 && composition.height > 0 ? canvasSize.height / composition.height : 1;
    const minW = sx > 0 ? GIZMO_MIN_CONTENT_CSS / sx : GIZMO_MIN_CONTENT_CSS;
    const minH = sy > 0 ? GIZMO_MIN_CONTENT_CSS / sy : GIZMO_MIN_CONTENT_CSS;
    for (const o of composition.overlays) {
      if (!isOverlayIn3dMode(o)) continue;
      let content: OverlayRect | null = null;
      const usesThreeText = o.kind === "text" && (o as TextOverlay).threeD != null;
      if (o.kind === "three") {
        // Window model: a three overlay's selection box IS its rect (the scene
        // renders into that window). No content-bounds projection.
        content = o.rect;
      } else if (usesThreeText) {
        const inst = threeScenes[o.id];
        content = contentBoundsToRectUnclamped(o.rect, inst?.contentBoundsNDC?.() ?? null);
      } else {
        // Spatial-quad kinds (image/video/code, non-extruded tilted text): use
        // the unclamped projected quad bbox so the outline can exceed the base rect.
        const t = resolveOverlayTransform(o);
        if (classifyTransform(t) === "spatial") {
          content = projectSpatialQuadBboxUnclamped(o.rect, t, resolveFlip(o));
        }
      }
      if (content) out[o.id] = floorContentRect(content, o.rect, minW, minH);
    }
    return out;
    // NOT keyed on `frame`: the projected box only changes when the transform changes
    // (an edit mutates `composition`), and measuring it is a Box3 traversal that must
    // stay OFF the 30Hz playback loop. Recomputes on edit / resize / instance change only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composition, threeScenes, canvasSize.width, canvasSize.height]);

  // Fetch track JSON for any tracked overlays. Keyed by trackId.
  const tracks = useOverlayTracks(composition?.overlays);

  const queryClient = useQueryClient();
  // x,y = cursor in composition px; w,h = the tracked subject's on-screen
  // size (display px) captured at drag start so the ghost represents the
  // actual thing being moved, not an arbitrary square.
  const [dragGhost, setDragGhost] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [showRevealOutline, setShowRevealOutline] = useState(false);
  // Track which overlay is being hovered for the cursor + reveal outline.
  const [hoveredTrackedId, setHoveredTrackedId] = useState<string | null>(null);
  // Ref mirror so handleCanvasMouseMove doesn't re-create on every hover boundary crossing.
  const hoveredTrackedIdRef = useRef<string | null>(null);
  // Auto-hide timer for the reveal outline — cleaned up on unmount; cleared
  // before re-set so a rapid second click can't leave a double timer.
  const revealOutlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref for active drag window listeners — ensures cleanup even if the component unmounts mid-drag.
  const activeDragListenersRef = useRef<{ move: (ev: MouseEvent) => void; up: (ev: MouseEvent) => void } | null>(null);
  // Same, for an in-flight palette drag (chip → canvas).
  const paletteDragRef = useRef<{ move: (ev: MouseEvent) => void; up: (ev: MouseEvent) => void } | null>(null);

  // Export dialog open-state (observed, not controlled — ExportDialog stays
  // uncontrolled and just notifies us via onOpenChange) + the post-close
  // success toast. If the export finishes while the dialog is CLOSED, we
  // surface a dismissible "Exported …" pill next to the Export button.
  const [exportOpen, setExportOpen] = useState(false);
  const [exportToast, setExportToast] = useState<{ filePath: string; filename: string } | null>(null);
  const prevExportStatusRef = useRef(exportFlow.status);
  const exportOpenRef = useRef(exportOpen);
  exportOpenRef.current = exportOpen;
  useEffect(() => {
    const prev = prevExportStatusRef.current;
    prevExportStatusRef.current = exportFlow.status;
    // A fresh export starting clears any stale toast.
    if (exportFlow.status === "starting") {
      setExportToast(null);
      return;
    }
    // Capture on the success EDGE, while flow.result is still set (the dialog
    // resets it on close). Only toast when the dialog was closed at finish —
    // an open dialog already shows its own success card.
    const becameSuccess = prev !== "success" && exportFlow.status === "success";
    if (becameSuccess && !exportOpenRef.current && exportFlow.result) {
      const fp = exportFlow.result.filePath;
      setExportToast({ filePath: fp, filename: fp.split(/[\\/]/).pop() ?? fp });
    }
  }, [exportFlow.status, exportFlow.result]);

  // Reopening the dialog after a post-close finish: the flow is still in a
  // terminal state (it only resets on a terminal-state close, which never
  // happened because the dialog was already closed when the export finished).
  // On the closed→open transition, clear any pending toast and reset a
  // terminal flow so the dialog shows the export FORM, not a stale result card.
  const prevExportOpenRef = useRef(exportOpen);
  useEffect(() => {
    const wasOpen = prevExportOpenRef.current;
    prevExportOpenRef.current = exportOpen;
    if (!wasOpen && exportOpen) {
      setExportToast(null);
      if (
        exportFlow.status === "success" ||
        exportFlow.status === "failed" ||
        exportFlow.status === "cancelled"
      ) {
        exportFlow.reset();
      }
    }
  }, [exportOpen, exportFlow]);

  // Re-anchor debounce: a drag snaps optimistically immediately, but the
  // actual POST + seeded re-track is deferred REANCHOR_DEBOUNCE_SECONDS after
  // the LAST drag so the user can fine-tune first. The button shows the
  // countdown; the pending correction is held in a ref until it fires.
  const [reanchorCountdown, setReanchorCountdown] = useState<number | null>(null);
  const pendingReanchorRef = useRef<{ trackId: string; anchor: ManualAnchor } | null>(null);
  const reanchorIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef(0);
  // manualAnchors as they were BEFORE the current pending correction started.
  // Captured only on the no-pending → pending transition, so a revert always
  // returns to the pre-correction state even after several fine-tune re-drags.
  const pendingPriorRef = useRef<{ trackId: string; prior: ManualAnchor[] } | null>(null);

  // "Re-tracking…" indicator on the Adjust-tracking button. Set when a
  // committed re-anchor's seeded re-track is dispatched; cleared when the
  // track query settles with a CHANGED segment set (the recompute upserts a
  // bounded segment) or after a safety timeout. Refs mirror state so the
  // queryCache subscription can read them without re-subscribing.
  const [reanchorBusy, setReanchorBusy] = useState(false);
  const reanchorBusyRef = useRef(false);
  const reanchorBusyTrackIdRef = useRef<string | null>(null);
  const reanchorBusySigRef = useRef<string>("");
  const reanchorBusySinceRef = useRef<number>(0);
  const reanchorBusyUpdatedAtRef = useRef<number>(0);
  const reanchorBusyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The track with an in-flight re-anchor (countdown OR Re-tracking). While
  // non-null, every OTHER overlay is locked in the palette + on the canvas
  // so a second re-anchor can't start until this one finishes or is
  // cancelled — one correction in flight at a time, no serialization edge.
  const [activeReanchorTrackId, setActiveReanchorTrackId] = useState<string | null>(null);

  const clearReanchorBusy = useCallback(() => {
    reanchorBusyRef.current = false;
    reanchorBusyTrackIdRef.current = null;
    if (reanchorBusyTimerRef.current) {
      clearTimeout(reanchorBusyTimerRef.current);
      reanchorBusyTimerRef.current = null;
    }
    setReanchorBusy(false);
    setActiveReanchorTrackId(null);
  }, []);

  // Briefly show a static outline over the tracked-overlay art so the user
  // can see what's tracked (used by the "Adjust tracking" button AND a plain
  // click on a tracked object). No animation — just a 2s reveal.
  const revealTracked = useCallback(() => {
    if (revealOutlineTimerRef.current) clearTimeout(revealOutlineTimerRef.current);
    setShowRevealOutline(true);
    revealOutlineTimerRef.current = setTimeout(() => setShowRevealOutline(false), 2000);
  }, []);

  // Commit the pending re-anchor: POST (server persists + seeded re-track +
  // chat note) then invalidate so the corrected window repaints. Fire-and-
  // forget; the optimistic cache already reflects it.
  const flushPendingReanchor = useCallback(() => {
    const p = pendingReanchorRef.current;
    pendingReanchorRef.current = null;
    pendingPriorRef.current = null; // committed — nothing left to revert as pending
    if (!p || !pieceId) return;

    // Enter the "Re-tracking…" state. Snapshot the segment signature NOW
    // (post-optimistic, pre-recompute) so the queryCache watcher can tell
    // the immediate optimistic refetch (same segments) from the real
    // post-recompute settle (a new bounded segment → changed signature).
    const key = trackKeys.detail(p.trackId);
    reanchorBusyTrackIdRef.current = p.trackId;
    reanchorBusySigRef.current = trackSegmentsSig(queryClient.getQueryData<Track>(key));
    reanchorBusySinceRef.current = Date.now();
    reanchorBusyUpdatedAtRef.current =
      queryClient.getQueryState<Track>(key)?.dataUpdatedAt ?? 0;
    reanchorBusyRef.current = true;
    setReanchorBusy(true);
    if (reanchorBusyTimerRef.current) clearTimeout(reanchorBusyTimerRef.current);
    reanchorBusyTimerRef.current = setTimeout(clearReanchorBusy, REANCHOR_BUSY_TIMEOUT_MS);

    fetch(`/api/pieces/${pieceId}/tracks/${p.trackId}/manual-anchors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ time: p.anchor.time, bbox: p.anchor.bbox }),
    }).catch(() => {});
    queryClient.invalidateQueries({ queryKey: trackKeys.detail(p.trackId) });
  }, [pieceId, queryClient, clearReanchorBusy]);

  // Clear the "Re-tracking…" indicator + the overlay lock once the track
  // query for the busy track settles after the re-track actually finished.
  // Two clear signals (whichever first):
  //   • segment signature changed — the seeded re-track upserted its
  //     bounded segment (the apply path); fast.
  //   • a settle ≥ MIN_SETTLE_MS after commit — covers the never-make-worse
  //     "lost" path, which resolves with NO segment change but still emits
  //     the server refresh_query → a (late) refetch settle.
  // The immediate optimistic invalidate settles in well under MIN_SETTLE_MS
  // with an unchanged signature, so it can't false-clear.
  useEffect(() => {
    const MIN_SETTLE_MS = 2500;
    const cache = queryClient.getQueryCache();
    return cache.subscribe(() => {
      if (!reanchorBusyRef.current) return;
      const tid = reanchorBusyTrackIdRef.current;
      if (!tid) return;
      const key = trackKeys.detail(tid);
      const state = queryClient.getQueryState<Track>(key);
      if (!state || state.fetchStatus !== "idle") return;
      // Only act when THIS track query actually got NEW data (a real
      // refetch), not on unrelated cache churn. Record every advance so
      // the next one is detected: the optimistic invalidate is the 1st
      // advance (early, unchanged sig → ignored); the server's completion
      // refresh_query is a later advance → clears (sig changed on the
      // apply path, or simply late enough on the never-make-worse path).
      if (state.dataUpdatedAt === reanchorBusyUpdatedAtRef.current) return;
      reanchorBusyUpdatedAtRef.current = state.dataUpdatedAt;
      const sigChanged =
        trackSegmentsSig(queryClient.getQueryData<Track>(key)) !== reanchorBusySigRef.current;
      const lateEnough = Date.now() - reanchorBusySinceRef.current > MIN_SETTLE_MS;
      if (sigChanged || lateEnough) {
        clearReanchorBusy();
      }
    });
  }, [queryClient, clearReanchorBusy]);

  // Latest flush, callable from the []-deps unmount cleanup without staleness.
  // Synced in an effect (not during render — react-hooks/refs).
  const flushRef = useRef(flushPendingReanchor);
  useEffect(() => {
    flushRef.current = flushPendingReanchor;
  }, [flushPendingReanchor]);

  // (Re)start the 5→1 countdown. Each new drag calls this, resetting the
  // window so rapid fine-tuning doesn't dispatch until the user settles.
  // Note: a running interval closes over the flushPendingReanchor that was
  // current when this was last (re)created — fine because pieceId is a
  // per-session prop; an in-place pieceId swap mid-countdown (no remount) is
  // an accepted, near-impossible edge (piece switches unmount this component,
  // and the []-cleanup flushes via the synced flushRef).
  const startOrResetCountdown = useCallback(() => {
    if (reanchorIntervalRef.current) clearInterval(reanchorIntervalRef.current);
    countdownRef.current = REANCHOR_DEBOUNCE_SECONDS;
    setReanchorCountdown(REANCHOR_DEBOUNCE_SECONDS);
    reanchorIntervalRef.current = setInterval(() => {
      countdownRef.current -= 1;
      if (countdownRef.current <= 0) {
        if (reanchorIntervalRef.current) clearInterval(reanchorIntervalRef.current);
        reanchorIntervalRef.current = null;
        setReanchorCountdown(null);
        flushPendingReanchor();
      } else {
        setReanchorCountdown(countdownRef.current);
      }
    }, 1000);
  }, [flushPendingReanchor]);

  // Revert ONLY a still-pending (uncommitted) re-anchor: cancel the countdown,
  // clear the pending commit, and restore the cache to the pre-correction
  // state. No server call. Already-committed anchors are intentionally NOT
  // undone — they may sit on a scene/frame the user isn't looking at, so
  // silently reverting them would be confusing. No-op if nothing is pending.
  const revertPending = useCallback(() => {
    if (!pendingReanchorRef.current) return;
    if (reanchorIntervalRef.current) {
      clearInterval(reanchorIntervalRef.current);
      reanchorIntervalRef.current = null;
    }
    setReanchorCountdown(null);
    setActiveReanchorTrackId(null);
    const snap = pendingPriorRef.current;
    pendingReanchorRef.current = null;
    pendingPriorRef.current = null;
    if (snap) {
      const key = trackKeys.detail(snap.trackId);
      const prev = queryClient.getQueryData<Track>(key);
      if (prev) {
        queryClient.setQueryData(
          key,
          mergeManualAnchorsIntoTrack({ ...prev, manualAnchors: snap.prior }),
        );
      }
    }
  }, [queryClient]);

  // Build + commit a dragged anchor for a tracked overlay. Shared by the
  // direct canvas-art drag AND the palette drag (which works even when the
  // track is lost — `recoverManualBbox` falls back to the first visible
  // sample's size when there's no sample at `time`). Optimistic snap is
  // instant; the POST is deferred behind the debounce countdown.
  const commitDraggedAnchor = useCallback(
    (p: {
      trackId: string;
      overlayRect: OverlayRect;
      fit: TrackFit;
      scale: number;
      smoothing: TrackSmoothing;
      time: number;
      drop: { x: number; y: number };
      frameW: number;
      frameH: number;
      /** The overlay's follow offset — the art the user grabbed renders with
       *  it, so recoverManualBbox must subtract it (see RecoverManualBboxOpts). */
      offset?: { x: number; y: number };
      /** The overlay's source↔composition mapping, from its owning video. The
       *  drop point is in composition pixels but a ManualAnchor's time and
       *  bbox are in the SOURCE clip's space, so the whole gesture is computed
       *  in composition pixels and converted back at the end. Identity for a
       *  full-frame untrimmed video at t=0. */
      space: TrackedSpace;
    }) => {
      const trackData = tracks[p.trackId] as Track | undefined;
      const clipTime = trackedClipTime(p.space, p.time);
      const raw = trackData ? sampleTrack(trackData, clipTime, p.smoothing) : null;
      const s = raw ? { ...raw, ...trackBoxToComposition(p.space, raw) } : null;

      let fallbackSize: { w: number; h: number } | undefined;
      if (trackData) {
        const firstVisible = trackData.samples.find((q) => q.visible);
        if (firstVisible) {
          const box = trackBoxToComposition(p.space, firstVisible);
          fallbackSize = { w: box.w, h: box.h };
        }
      }

      const compBbox = recoverManualBbox({
        sample: s && s.visible ? s : null,
        fit: p.fit,
        scale: p.scale,
        rect: p.overlayRect,
        frame: { width: p.frameW, height: p.frameH },
        dropCenter: p.drop,
        fallbackSize,
        offset: p.offset,
      });
      const src = compositionBoxToTrack(p.space, {
        x: compBbox[0], y: compBbox[1], w: compBbox[2], h: compBbox[3],
      });
      const bbox: [number, number, number, number] = [src.x, src.y, src.w, src.h];

      // createdAt marks the pin newer than every existing manual segment so
      // the optimistic stamp applies until ITS re-track lands (consumption —
      // see isManualAnchorConsumed). The server re-stamps its own clock.
      // `time` is CLIP time: a manual anchor pins the subject in the source
      // file, and the re-track window the server derives from it is measured
      // on the track's own clock (ManualAnchor.time).
      const anchor = { id: manualAnchorId(clipTime), time: clipTime, bbox, createdAt: Date.now() };

      const key = trackKeys.detail(p.trackId);
      const prev = queryClient.getQueryData<Track>(key);
      if (prev) {
        const priorPending = pendingReanchorRef.current;
        let baseAnchors = prev.manualAnchors ?? [];
        if (
          priorPending &&
          priorPending.trackId === p.trackId &&
          priorPending.anchor.id !== anchor.id
        ) {
          baseAnchors = baseAnchors.filter((a) => a.id !== priorPending.anchor.id);
        }
        const manualAnchors = upsertManualAnchor(baseAnchors, anchor);
        queryClient.setQueryData(key, mergeManualAnchorsIntoTrack({ ...prev, manualAnchors }));
      }

      // A pending re-anchor on a DIFFERENT track must commit now (single
      // pendingRef); same-track re-drags are fine-tuning and just replace.
      const existingPending = pendingReanchorRef.current;
      if (existingPending && existingPending.trackId !== p.trackId) {
        flushRef.current?.();
      }
      if (!pendingReanchorRef.current) {
        pendingPriorRef.current = { trackId: p.trackId, prior: prev?.manualAnchors ?? [] };
      }
      pendingReanchorRef.current = { trackId: p.trackId, anchor };
      setActiveReanchorTrackId(p.trackId);
      startOrResetCountdown();
    },
    [tracks, queryClient, startOrResetCountdown],
  );

  // The overlay-drag palette (under the top bar). Opened by "Adjust
  // tracking" — lets the user grab ANY tracked overlay (even one whose
  // track is currently lost / not rendered) and drag it onto the canvas.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The user-picked tracked overlay. Overrides the highest-z auto-pick so
  // the timeline anchor markers + re-anchor palette scope to it on
  // multi-overlay videos. Null ⇒ fall back to the legacy highest-z behavior.
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);

  // Tracked overlays whose time window covers the playhead (anchoring
  // outside an overlay's range is meaningless). overlaysActiveAt returns
  // ascending z, so the last entry is the top-most.
  const time = composition ? frame / composition.fps : 0;
  // The transform box/handles should only show while the selected overlay is
  // actually on-screen at the playhead. An overlay outside its
  // [startTime, startTime+duration) window isn't rendered, so drawing its box
  // there is a phantom — hide it (the overlay stays selected in the inspector +
  // timeline; the box reappears once the playhead enters its window).
  const selectedOverlayActiveAtPlayhead =
    !!transformSelectedOverlay &&
    transformSelectedOverlay.duration > 0 &&
    time >= transformSelectedOverlay.startTime &&
    time < transformSelectedOverlay.startTime + transformSelectedOverlay.duration;
  // Gate for the on-canvas transform UI (gizmo / handles / box / readability
  // pill). Hidden WHILE PLAYING: that subtree re-renders every frame and its
  // per-frame allocation triggers a recurring major GC → playback stutter
  // (measured: selecting a 3D overlay = 0→6 GC hitches/10s). Pro-editor behavior
  // anyway — handles vanish during playback, reappear on pause. You can't drag
  // while playing. See docs-local/superpowers/notes/smoothness-fixture.md.
  const showTransformUI = showTransformUi(playing, selectedOverlayActiveAtPlayhead);
  const activeTracked = composition
    ? overlaysActiveAt(composition.overlays ?? [], time).filter((o) => o.kind === "tracked")
    : [];
  // Picked overlay if it's still active, else highest-z (legacy default).
  const selectedTrackedOverlay =
    activeTracked.find((o) => o.id === selectedOverlayId) ??
    (activeTracked.length > 0 ? activeTracked[activeTracked.length - 1] : null);
  const selectedTrackId = selectedTrackedOverlay?.kind === "tracked" ? selectedTrackedOverlay.trackId : null;

  // Drag a tracked overlay from the palette onto the canvas. Works even
  // when the track is lost (nothing rendered to grab) — that's the whole
  // point. A click (no movement) just selects + reveals it. Dropping off
  // the canvas cancels. Pointer-based (mirrors the canvas-art drag) so
  // both paths share commitDraggedAnchor + the debounce countdown.
  const startPaletteDrag = useCallback(
    (o: TrackedOverlay, e: React.MouseEvent) => {
      if (!composition) return;
      e.preventDefault();
      const downX = e.clientX;
      const downY = e.clientY;
      let didPause = false;
      let moved = false;

      const td = tracks[o.trackId] as Track | undefined;
      const space = resolveTrackedSpace(o, td, composition.overlays);
      const fv = td?.samples.find((s) => s.visible);
      let gW = 64;
      let gH = 64;
      if (fv) {
        const art = resolveTrackedRect(
          trackBoxToComposition(space, fv),
          o,
          { width: composition.width, height: composition.height },
        );
        gW = Math.max(24, (art.w / composition.width) * (canvasSize.width || 1));
        gH = Math.max(24, (art.h / composition.height) * (canvasSize.height || 1));
      }

      const insideCanvas = (ev: MouseEvent): DOMRect | null => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const b = canvas.getBoundingClientRect();
        return ev.clientX >= b.left && ev.clientX <= b.right &&
          ev.clientY >= b.top && ev.clientY <= b.bottom
          ? b
          : null;
      };

      const move = (ev: MouseEvent) => {
        if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > DRAG_THRESHOLD_PX) moved = true;
        if (moved && !didPause && playing) {
          didPause = true;
          onPlayToggle();
        }
        const b = insideCanvas(ev);
        if (moved && b) {
          const pt = screenToCompositionPoint(ev, b, composition.width, composition.height);
          setDragGhost({ x: pt.x, y: pt.y, w: gW, h: gH });
        } else {
          setDragGhost(null);
        }
      };

      const up = (ev: MouseEvent) => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        paletteDragRef.current = null;
        setDragGhost(null);
        // Picking an overlay (click or drag) scopes the panel + markers.
        setSelectedOverlayId(o.id);
        if (!moved) {
          revealTracked();
          return;
        }
        if (!pieceId) return;
        const b = insideCanvas(ev);
        if (!b) return; // dropped off-canvas → cancel
        const drop = screenToCompositionPoint(ev, b, composition.width, composition.height);
        commitDraggedAnchor({
          trackId: o.trackId,
          overlayRect: o.rect,
          fit: o.fit,
          scale: o.scale,
          smoothing: o.smoothing,
          time,
          drop,
          frameW: composition.width,
          frameH: composition.height,
          offset: o.offset,
          space,
        });
      };

      paletteDragRef.current = { move, up };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [
      composition,
      tracks,
      playing,
      onPlayToggle,
      canvasSize,
      pieceId,
      time,
      commitDraggedAnchor,
      revealTracked,
    ],
  );

  // Read the stable manualAnchors reference once, outside the memo.
  // tracks (the map) is a fresh object every render (useOverlayTracks builds a
  // new {} each call), so keying useMemo on `tracks` causes it to re-run every
  // render. tracks[selectedTrackId]?.manualAnchors IS referentially stable across
  // renders when the underlying anchors are unchanged:
  //   • no-anchor path: mergeManualAnchorsIntoTrack returns the same track ref
  //     (early return), so ?.manualAnchors is the same cached value.
  //   • has-anchor path: mergeManualAnchorsIntoTrack returns a new object via
  //     spread but does NOT override manualAnchors, so the spread preserves the
  //     original manualAnchors array reference from the React Query cache.
  // Keying on this stable inner value breaks the setTimelineMarkers render loop.
  const selectedManualAnchors =
    selectedTrackId ? (tracks[selectedTrackId] as Track | undefined)?.manualAnchors : undefined;
  const selectedAnchors: ManualAnchor[] = useMemo(
    () => selectedManualAnchors ?? [],
    // selectedManualAnchors is referentially stable across renders when the
    // track's anchors are unchanged — see comment above. Do NOT depend on
    // tracks (the map) here: it is a fresh object every render.
    [selectedManualAnchors],
  );

  // Map to the shape the parent expects. Stable reference when anchor content
  // (id/time) is unchanged — the effect below only fires on real content changes.
  const mappedSelectedAnchors = useMemo(
    () => selectedAnchors.map((a) => ({ time: a.time, id: a.id })),
    [selectedAnchors],
  );

  // Propagate selected anchors to parent (for timeline marker ticks).
  // Keyed on mappedSelectedAnchors so ANY content change (id, time, bbox)
  // notifies the parent — not just count changes.
  useEffect(() => {
    onSelectedAnchorsChange?.(mappedSelectedAnchors);
  }, [mappedSelectedAnchors, onSelectedAnchorsChange]);

  // Combined unmount cleanup — clear the show-hint timer + the re-anchor
  // countdown interval, remove any active drag window listeners, and
  // best-effort commit any un-dispatched re-anchor so a navigation away
  // mid-countdown doesn't silently lose the user's correction.
  useEffect(() => () => {
    if (revealOutlineTimerRef.current) clearTimeout(revealOutlineTimerRef.current);
    if (reanchorIntervalRef.current) clearInterval(reanchorIntervalRef.current);
    if (reanchorBusyTimerRef.current) clearTimeout(reanchorBusyTimerRef.current);
    for (const ref of [activeDragListenersRef, paletteDragRef]) {
      const l = ref.current;
      if (l) {
        window.removeEventListener("mousemove", l.move);
        window.removeEventListener("mouseup", l.up);
        ref.current = null;
      }
    }
    flushRef.current?.();
  }, []);

  // Ctrl/Cmd+Z reverts a PENDING re-anchor only. Ignored while typing in an
  // input/textarea/contenteditable, and only acts when something is pending
  // (so it never swallows undo elsewhere). Listener cleaned up on unmount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (e.key !== "z" && e.key !== "Z") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (!pendingReanchorRef.current) return;
      e.preventDefault();
      revertPending();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [revertPending]);

  // Resize canvas to fit container at the composition's actual aspect ratio.
  // Falls back to 16:9 only when no composition is loaded yet.
  const compW = composition?.width ?? 1920;
  const compH = composition?.height ?? 1080;
  // The observer/aspect math depends ONLY on the primitive dims + whether the
  // container is mounted. We deliberately do NOT depend on the `composition`
  // OBJECT: the merged composition is a fresh object on every edit tick, and
  // depending on its identity tore down + re-measured the container on every
  // edit → setCanvasSize churn → a visible canvas resize/reflow.
  //
  // `compositionLoaded` (a BOOLEAN, not the object) covers the null→loaded
  // transition: the container div only renders once `composition` is truthy
  // (see the early return below), so on the common path where the composition
  // loads ASYNC after a null first render — with dims equal to the 1920×1080
  // fallback — `compW`/`compH` never change; this flag flipping false→true is
  // what re-runs the effect to attach the observer (otherwise canvasSize stays
  // {0,0} and the transform controls are suppressed).
  const compositionLoaded = !!composition;
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const aspectRatio = compW / compH;
    const measure = (width: number, height: number) => {
      if (width <= 0 || height <= 0) return;
      let w = width;
      let h = width / aspectRatio;
      if (h > height) {
        h = height;
        w = height * aspectRatio;
      }
      setCanvasSize({ width: Math.floor(w), height: Math.floor(h) });
    };

    // Measure synchronously now; the ResizeObserver's first callback is async,
    // so this avoids a window where canvasSize is still {0,0}.
    const r0 = container.getBoundingClientRect();
    measure(r0.width, r0.height);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) measure(entry.contentRect.width, entry.contentRect.height);
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [compW, compH, compositionLoaded]);

  // Whole-frame-flash diagnostics: a composition-IDENTITY change or a canvas
  // backing-store realloc (width/height reassignment → the browser CLEARS the
  // canvas → a one-frame whole-canvas flash) recorded as marks, so a flicker
  // capture shows whether either coincides with the visible flash. Zero cost
  // when telemetry is off.
  const lastCompRef = useRef<typeof composition | null>(null);
  const lastCanvasDimsRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });

  const drawCurrentFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !composition) return;
    const t0 = performance.now();
    if (lastCompRef.current !== composition) {
      if (lastCompRef.current !== null) {
        recordPreviewEvent({ t: t0, type: "mark", label: "comp-identity-change" });
      }
      lastCompRef.current = composition;
    }
    if (lastCanvasDimsRef.current.w !== canvas.width || lastCanvasDimsRef.current.h !== canvas.height) {
      if (lastCanvasDimsRef.current.w !== 0) {
        recordPreviewEvent({ t: t0, type: "mark", label: `canvas-realloc ${canvas.width}x${canvas.height}` });
      }
      lastCanvasDimsRef.current = { w: canvas.width, h: canvas.height };
    }
    // Merge the in-flight overlay edits (if any) imperatively before painting.
    // The edit store's `getAll()` carries BOTH phases (gesture `preview` ticks +
    // `committed` entries); apply each patch over its overlay. The store is a
    // stable ref read here — NOT a dependency — so an edit repaints the canvas
    // through the imperative subscription below without re-creating this callback
    // or re-rendering. Identity fast-path when there are no edits.
    const edits = editStore?.getAll();
    // Hidden overlays (`o.hidden`, the persisted eye toggle) are excluded by
    // the renderer itself at the overlaysActiveAt chokepoint — no filter here.
    const comp =
      composition.overlays && edits && edits.size > 0
        ? {
            ...composition,
            overlays: composition.overlays.map((o) => {
              const editPatch = edits?.get(o.id)?.patch;
              return editPatch ? ({ ...o, ...editPatch } as typeof o) : o;
            }),
          }
        : composition;
    try {
      renderFrame(canvas, comp, frame, {}, videoSources, images, compiledDrawFns, tracks, threeScenes, spatialQuads, codeContentBoxes);
    } catch (e) {
      // renderFrame isolates per-scene/per-overlay draw errors internally, so a
      // throw here is a whole-frame failure (e.g. a bad composition shape). Log
      // it ONCE per message rather than swallowing silently — a silent catch
      // here previously hid a broken scene draw that blanked the entire preview.
      const msg = e instanceof Error ? e.message : String(e);
      if (!lastRenderErrorRef.current || lastRenderErrorRef.current !== msg) {
        lastRenderErrorRef.current = msg;
        // eslint-disable-next-line no-console
        console.error("[preview] renderFrame failed:", msg);
      }
    }
    const renderMs = performance.now() - t0;
    recordPreviewEvent({ t: t0, type: "render", frame, ms: renderMs });
    // Adaptive-supersample accounting: a frame whose compositor time exceeds the
    // frame budget (1000/fps) is "slow". The 1s tick below reads these counters.
    const stats = frameStatsRef.current;
    stats.total += 1;
    if (composition.fps > 0 && renderMs > 1000 / composition.fps) stats.slow += 1;
    // fontsVersion: bumps when a custom font finishes loading so a paused
    // preview repaints text with the now-available family.
  }, [composition, frame, videoSources, images, compiledDrawFns, codeContentBoxes, tracks, threeScenes, spatialQuads, fontsVersion]);

  useEffect(() => {
    drawCurrentFrame();
  }, [drawCurrentFrame]);

  // Keep a ref to the LATEST draw closure so the edit store's imperative repaint
  // always paints with current composition/frame/videoSources — not a stale
  // closure captured at subscribe time.
  const drawCurrentFrameRef = useRef(drawCurrentFrame);
  drawCurrentFrameRef.current = drawCurrentFrame;

  // Size the canvas BACKING store to display × supersample (crisp overlays), then
  // repaint. Before the ResizeObserver has measured the display size, fall back to
  // the composition's logical dims (scale 1) so the first paint is correct. Setting
  // canvas.width/height reallocs + clears the backing store, so guard on a real
  // change to avoid a per-frame realloc flash. useLayoutEffect so the backing size
  // is in place before the browser paints.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !composition) return;
    const measured = canvasSize.width > 0 && canvasSize.height > 0;
    const dispW = measured ? canvasSize.width : composition.width;
    const dispH = measured ? canvasSize.height : composition.height;
    const ss = measured ? supersample : 1;
    const w = Math.max(1, Math.round(dispW * ss));
    const h = Math.max(1, Math.round(dispH * ss));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      drawCurrentFrameRef.current?.();
    }
  }, [canvasSize.width, canvasSize.height, supersample, composition]);

  // Adaptive-supersample controller tick. Once per second, fold the window's
  // dropped-frame fraction into the pure controller; a sustained-slow run lowers
  // the effective cap toward 1 (keeping playback smooth on a weak GPU), and a
  // healthy run restores it with hysteresis. setEffectiveCap is a no-op re-render
  // when the cap is unchanged. Export is unaffected — it renders at full target res.
  useEffect(() => {
    const cfg = {
      maxCap: PREVIEW_SUPERSAMPLE_CAP,
      minCap: 1,
      dropTicks: SUPERSAMPLE_DROP_TICKS,
      recoverTicks: SUPERSAMPLE_RECOVER_TICKS,
    };
    const id = setInterval(() => {
      const { total, slow } = frameStatsRef.current;
      frameStatsRef.current = { total: 0, slow: 0 };
      // No frames this window (paused) counts as healthy → allows recovery.
      const stressed = total > 0 && slow / total >= SUPERSAMPLE_SLOW_FRACTION;
      superStateRef.current = nextSupersample(superStateRef.current, stressed, cfg);
      setEffectiveCap(superStateRef.current.cap);
    }, SUPERSAMPLE_TICK_MS);
    return () => clearInterval(id);
  }, []);
  // Edit-store imperative repaint: every write (preview OR committed) repaints
  // the canvas with the current draw fn (which merges the edit store above) —
  // no React re-render, whether paused or playing. The store coalesces fires to
  // one-per-frame internally when created with an rAF scheduler (see
  // PreviewSurface), so no extra rAF wrapper here.
  useEffect(() => {
    if (!editStore) return;
    return editStore.subscribeImperative(() => drawCurrentFrameRef.current());
  }, [editStore]);

  const handleCanvasPointerDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!composition?.overlays || composition.overlays.length === 0) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const bounds = canvas.getBoundingClientRect();
      const start = screenToCompositionPoint(e, bounds, composition.width, composition.height);
      const time = frame / composition.fps;
      const hit = hitTest(
        start.x,
        start.y,
        composition.overlays,
        time,
        tracks,
        { width: composition.width, height: composition.height },
        threeContentRects,
      );

      // Locked overlays ignore selection/handles entirely. A locked TRACKED
      // overlay still reaches the re-anchor path while "Adjust tracking" is ON
      // (track repair is a different edit surface); in default mode a locked
      // tracked overlay is inert like every other locked kind (reposition IS
      // an overlay edit).
      if (hit && getOverlayLocked(hit.id) && (hit.kind !== "tracked" || !paletteOpen)) {
        return;
      }

      // Any hit selects it (single-select). A miss clears selection. Selection
      // is set FIRST, then the kind-specific behavior (inline text edit /
      // tracked re-anchor) runs on top — the transform box + the editor coexist.
      selectionStore.set(hit ? hit.id : null);

      // Text overlays: a single click only SELECTS (shows the transform
      // handles). Entering the inline text editor is a DOUBLE-click
      // (handleCanvasDoubleClick) — this stops the select UI (the full-box
      // body-drag surface) and the inline contentEditable from fighting over
      // the same single click (which made the editor open-then-instantly-close
      // and blocked caret placement). Matches Figma / Canva / Premiere.
      if (hit && hit.kind === "text") {
        return;
      }

      // Tracked overlay — plain click reveals; a real drag either REPOSITIONS
      // (default: writes the follow offset live, never touches the track) or
      // RE-ANCHORS (while "Adjust tracking" is ON: the existing manual-anchor
      // + bounded re-track flow, with ghost + countdown).
      if (hit && hit.kind === "tracked") {
        const trackId = hit.trackId;
        const adjustTracking = paletteOpen;
        // Locked: a re-anchor is in flight for a DIFFERENT overlay. Ignore
        // interaction here so the user can't start a second one (mirrors
        // the disabled palette chips). Clears when it finishes/cancels.
        if (adjustTracking && activeReanchorTrackId !== null && trackId !== activeReanchorTrackId)
          return;
        const overlayId = hit.id;
        const overlayRect = hit.rect;
        const fit = hit.fit;
        const scale = hit.scale;
        const smoothing = hit.smoothing;
        const downClientX = e.clientX;
        const downClientY = e.clientY;
        const frameDims = { width: composition.width, height: composition.height };
        let didPause = false;
        let moved = false;

        // Capture the tracked subject's on-screen size now so the re-anchor
        // drag affordance is sized to the actual thing, not a fixed square.
        const trackData0 = tracks[trackId] as Track | undefined;
        const space = resolveTrackedSpace(hit, trackData0, composition.overlays);
        const s0 = sampleTrackedOverlay(hit, trackData0, composition.overlays, time);
        let ghostW = 64;
        let ghostH = 64;
        if (s0 && s0.visible) {
          const art0 = resolveTrackedRect(s0, hit, frameDims);
          ghostW = Math.max(24, (art0.w / composition.width) * (canvasSize.width || 1));
          ghostH = Math.max(24, (art0.h / composition.height) * (canvasSize.height || 1));
        }

        // composition.width/height are intentionally captured at pointer-down
        // (the frame the drag started on); a mid-drag panel resize is a
        // negligible, accepted edge case.
        const handleMouseMove = (ev: MouseEvent) => {
          if (Math.hypot(ev.clientX - downClientX, ev.clientY - downClientY) > DRAG_THRESHOLD_PX)
            moved = true;
          if (!moved) return;
          // Pause only once an actual drag begins, so a plain click that just
          // reveals the object doesn't disrupt playback.
          if (!didPause && playing) {
            didPause = true;
            onPlayToggle();
          }
          const bounds2 = canvas.getBoundingClientRect();
          const pt = screenToCompositionPoint(ev, bounds2, composition.width, composition.height);
          if (adjustTracking) {
            setDragGhost({ x: pt.x, y: pt.y, w: ghostW, h: ghostH });
          } else if (s0 && s0.visible) {
            // Reposition: live-write the follow offset. The edit store paints
            // it this frame; the PATCH is debounced inside
            // useOverlayTransformCommit and flushed on pointer-up.
            onOverlayTransformCommit(overlayId, {
              offset: offsetFromDrop({
                sample: s0,
                rect: overlayRect,
                fit,
                scale,
                frame: frameDims,
                drop: pt,
              }),
            });
          }
        };

        const handleMouseUp = (ev: MouseEvent) => {
          window.removeEventListener("mousemove", handleMouseMove);
          window.removeEventListener("mouseup", handleMouseUp);
          activeDragListenersRef.current = null;
          setDragGhost(null);

          // Click (no real drag): just reveal the tracked object. No edit.
          if (!moved) {
            revealTracked();
            return;
          }

          if (!adjustTracking) {
            // Reposition gesture: persist the accumulated offset now.
            onOverlayTransformFlush(overlayId);
            return;
          }

          if (!pieceId) return;

          const bounds2 = canvas.getBoundingClientRect();
          const drop = screenToCompositionPoint(ev, bounds2, composition.width, composition.height);
          commitDraggedAnchor({
            trackId,
            overlayRect,
            fit,
            scale,
            smoothing,
            time,
            drop,
            frameW: composition.width,
            frameH: composition.height,
            offset: hit.offset,
            space,
          });
        };

        // Record listeners before registering so the unmount cleanup can remove them.
        activeDragListenersRef.current = { move: handleMouseMove, up: handleMouseUp };
        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
      }
    },
    [
      composition,
      frame,
      tracks,
      playing,
      onPlayToggle,
      onEditOverlay,
      pieceId,
      revealTracked,
      canvasSize,
      commitDraggedAnchor,
      activeReanchorTrackId,
      selectionStore,
      getOverlayLocked,
      threeContentRects,
      paletteOpen,
      onOverlayTransformCommit,
      onOverlayTransformFlush,
    ],
  );

  // Double-click a text overlay to enter the inline text editor. Single click
  // only selects (handleCanvasPointerDown) so the transform handles and the
  // contentEditable never fight over the same click. This fires when the click
  // reaches the canvas (unselected overlay); when the overlay is already
  // selected, the body-drag surface is on top, so OverlayHandles forwards its
  // own double-click via onRequestEdit.
  const handleCanvasDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!composition?.overlays || composition.overlays.length === 0) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const bounds = canvas.getBoundingClientRect();
      const p = screenToCompositionPoint(e, bounds, composition.width, composition.height);
      const time = frame / composition.fps;
      const hit = hitTest(
        p.x,
        p.y,
        composition.overlays,
        time,
        tracks,
        { width: composition.width, height: composition.height },
        threeContentRects,
      );
      if (hit && hit.kind === "text" && !getOverlayLocked(hit.id)) {
        selectionStore.set(hit.id);
        onEditOverlay?.(hit.id);
      }
    },
    [composition, frame, tracks, onEditOverlay, selectionStore, getOverlayLocked, threeContentRects],
  );

  const handleCanvasMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!composition?.overlays || composition.overlays.length === 0) {
        // Compare via ref so the callback identity doesn't change on every hover boundary crossing.
        if (hoveredTrackedIdRef.current !== null) {
          hoveredTrackedIdRef.current = null;
          setHoveredTrackedId(null);
        }
        return;
      }
      const canvas = canvasRef.current;
      if (!canvas) return;
      const bounds = canvas.getBoundingClientRect();
      const pt = screenToCompositionPoint(e, bounds, composition.width, composition.height);
      const time = frame / composition.fps;
      const hit = hitTest(
        pt.x, pt.y,
        composition.overlays,
        time,
        tracks,
        { width: composition.width, height: composition.height },
        threeContentRects,
      );
      const nextId = hit?.kind === "tracked" ? hit.id : null;
      // Guard via ref, not state, so this callback is stable across hover changes.
      if (nextId !== hoveredTrackedIdRef.current) {
        hoveredTrackedIdRef.current = nextId;
        setHoveredTrackedId(nextId);
      }
    },
    [composition, frame, tracks, threeContentRects],
  );

  // A TRUE null composition = no piece selected / still loading. (An empty
  // piece now yields a NON-null composition with scenes:[], so it falls
  // through to the normal canvas surface below + the empty-state hint.)
  if (!composition) {
    return (
      <div className="flex h-full items-center justify-center bg-surface">
        <p className="text-sm text-muted-foreground">
          Generate a video to see preview
        </p>
      </div>
    );
  }

  // Empty piece: a valid (black-background) composition with nothing on it yet.
  // Render the normal canvas surface so the black background shows, plus a
  // centered, non-blocking hint. Any overlay suppresses the hint and renders
  // the canvas as usual.
  const isEmptyComposition = (composition.overlays?.length ?? 0) === 0;

  const isExporting = exportFlow.status === "starting" || exportFlow.status === "running";
  const exportProgressRatio =
    exportFlow.progress && exportFlow.progress.total > 0
      ? Math.max(0, Math.min(1, exportFlow.progress.done / exportFlow.progress.total))
      : null;

  // Surface hidden-`<video>` load failures (typically: unsupported codec, no proxy yet)
  // so the user isn't staring at a black canvas wondering why only overlays render.
  const activeVideoErrors: Array<{ id: string; name: string; message: string }> = [];
  if (composition && videoErrors) {
    // Scenes are canvas-only — they mount no <video>, so only overlays can error.
    for (const o of composition.overlays ?? []) {
      if (o.kind !== "video") continue;
      const err = videoErrors[o.id];
      if (err) activeVideoErrors.push({ id: o.id, name: `Overlay ${o.id.slice(0, 6)}`, message: err.message });
    }
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Top bar with export */}
      <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-2">
        <span className="text-xs font-medium text-muted-foreground">Preview</span>
        <div className="flex items-center gap-2">
          {(composition.overlays ?? []).some((o) => o.kind === "tracked") && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex" />}>
                  <button
                    data-testid="reanchor-hint-button"
                    onClick={
                      reanchorCountdown !== null
                        ? revertPending
                        : () => {
                            revealTracked();
                            setPaletteOpen((v) => !v);
                          }
                    }
                    className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all ${
                      reanchorCountdown !== null
                        ? "border-rose-500/60 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"
                        : reanchorBusy
                        ? "border-sky-500/50 bg-sky-500/10 text-sky-300"
                        : "border-amber-500/50 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
                    }`}
                  >
                    {reanchorCountdown !== null ? (
                      <>
                        <span
                          aria-hidden
                          className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-rose-500/30 text-[10px] font-semibold tabular-nums text-rose-200"
                        >
                          {reanchorCountdown}
                        </span>
                        Stop &amp; revert
                      </>
                    ) : reanchorBusy ? (
                      <>
                        <svg
                          className="h-3 w-3 animate-spin"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          aria-hidden
                        >
                          <circle cx="8" cy="8" r="6" strokeOpacity="0.3" />
                          <path d="M8 2a6 6 0 0 1 6 6" strokeLinecap="round" />
                        </svg>
                        Re-tracking…
                      </>
                    ) : (
                      "Adjust tracking"
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="max-w-xs">
                    Drag the overlay on the video to MOVE it relative to the
                    tracked subject (a follow offset — the track is untouched).
                    Turn this ON to fix the TRACK instead: it opens a palette
                    of the tracked overlays here — drag one onto the video to
                    re-anchor it, even if its track is lost and nothing is
                    drawn. The re-anchor applies a few seconds after your last
                    drag — during that countdown, click this button or press{" "}
                    <kbd className="rounded bg-background/40 px-1">Ctrl/⌘+Z</kbd>{" "}
                    to stop and revert. Once applied it shows “Re-tracking…”
                    until the segment finishes.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        <div className="relative inline-flex">
          <ExportDialog
            pieceId={pieceId || null}
            pieceName={pieceName ?? null}
            compositionWidth={composition?.width ?? 1920}
            compositionHeight={composition?.height ?? 1080}
            hasOverlays={(composition?.overlays?.length ?? 0) > 0}
            flow={exportFlow}
            hasSnapshot={hasSnapshot}
            hasDraft={hasDraft}
            onOpenChange={setExportOpen}
          />
          {exportToast && (
            <div className="absolute top-full right-0 z-20 mt-2">
              <ExportSuccessToast
                filename={exportToast.filename}
                onOpenFolder={() => {
                  void revealFile(exportToast.filePath);
                  setExportToast(null);
                }}
                onDismiss={() => setExportToast(null)}
              />
            </div>
          )}
        </div>
        {onToggleLayers && (
          <button
            type="button"
            data-testid="toggle-layers-panel"
            onClick={onToggleLayers}
            aria-label={layersDocked ? "Hide layers panel" : "Show layers panel"}
            title={layersDocked ? "Hide layers panel" : "Show layers panel"}
            className={`flex size-7 cursor-pointer items-center justify-center rounded-md transition-colors ${
              layersDocked
                ? "bg-surface-hover text-foreground"
                : "text-muted-foreground hover:bg-surface-hover hover:text-foreground"
            }`}
          >
            <Layers className="size-3.5" strokeWidth={1.8} />
          </button>
        )}
        </div>
      </div>

      {/* Overlay palette — opened by "Adjust tracking". Drag any tracked
          overlay onto the video to re-anchor it, even when its track is
          lost (nothing rendered to grab). Click a chip to scope the
          inspector's Anchors tab + timeline markers to that overlay. */}
      {paletteOpen && (
        <div
          data-testid="overlay-palette"
          className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2"
        >
          <span className="text-[11px] text-muted-foreground">
            {activeTracked.length === 0
              ? "No tracked overlays at this time — move the playhead into an overlay's range. (Dragging while this panel is open RE-ANCHORS the track; close it to reposition the sticker instead.)"
              : activeReanchorTrackId !== null
              ? "Finishing a re-anchor — other overlays are locked until it completes (or you cancel it)."
              : "Drag an overlay onto the video to re-anchor it (works even if it's lost):"}
          </span>
          {activeTracked.map((o) => {
            if (o.kind !== "tracked") return null;
            const tr = tracks[o.trackId] as Track | undefined;
            const s = sampleTrackedOverlay(o, tr, composition.overlays, time);
            const visible = !!(s && s.visible);
            const isSel = o.id === selectedTrackedOverlay?.id;
            const label = o.content.kind === "emoji" ? o.content.char : o.content.kind;
            // Lock every OTHER overlay while one re-anchor is in flight.
            const chipLocked =
              activeReanchorTrackId !== null && o.trackId !== activeReanchorTrackId;
            return (
              <button
                key={o.id}
                data-testid={`overlay-chip-${o.id}`}
                disabled={chipLocked}
                onMouseDown={chipLocked ? undefined : (e) => startPaletteDrag(o, e)}
                title={
                  chipLocked
                    ? "Another re-anchor is in progress — wait for it to finish or cancel it first"
                    : visible
                    ? "Visible — drag to re-anchor"
                    : "Lost / not shown — drag onto the subject to re-anchor it"
                }
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
                  chipLocked
                    ? "cursor-not-allowed border-border bg-background text-muted-foreground opacity-40"
                    : `cursor-grab active:cursor-grabbing ${
                        isSel
                          ? "border-amber-500 bg-amber-500/15 text-amber-300"
                          : "border-border bg-background text-foreground hover:bg-surface-hover"
                      }`
                }`}
              >
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 rounded-full ${visible ? "bg-emerald-400" : "bg-rose-400"}`}
                />
                <span className="max-w-[10rem] truncate">{label}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Export progress bar */}
      {isExporting && (
        <div className="h-1 w-full bg-background">
          <div
            className="h-full bg-primary transition-all duration-200"
            style={{ width: `${(exportProgressRatio ?? 0) * 100}%` }}
          />
        </div>
      )}

      {/* Canvas area — always flex-1 so it absorbs the column's slack.
          The panel/palette opening "minimizes" the preview by taking
          height (the canvas shrinks by exactly that much); a fixed
          flex-basis here left grow:0 dead space below the controls. */}
      <div
        ref={containerRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/40 p-4"
      >
        <div className="relative" style={{ width: canvasSize.width || "100%", height: canvasSize.height || "auto" }}>
          <canvas
            data-testid="preview-canvas"
            ref={canvasRef}
            onMouseDown={(e) => {
              handleCanvasPointerDown(e);
            }}
            onDoubleClick={handleCanvasDoubleClick}
            onMouseMove={handleCanvasMouseMove}
            // NB: the backing store (canvas.width/height) is set imperatively in a
            // layout effect to display × supersample — NOT here — so React can't
            // clobber it back to the logical size on re-render. The CSS size below
            // is the display size; the backing store is higher-res for crisp overlays.
            style={{
              width: canvasSize.width || "100%",
              height: canvasSize.height || "auto",
              maxWidth: "100%",
              maxHeight: "100%",
              cursor: hoveredTrackedId
                ? "move"
                : (composition.overlays?.length ?? 0) > 0
                ? "pointer"
                : "default",
              display: "block",
            }}
            className="rounded"
          />
          {isEmptyComposition && (
            <div
              data-testid="preview-empty-hint"
              className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center"
            >
              <p className="text-sm text-muted-foreground">
                Add a video, text, or code overlay to start
              </p>
            </div>
          )}
          {editingOverlay && (
            <OverlayEditor
              key={editingOverlay.id}
              overlay={editingOverlay}
              compositionWidth={composition.width}
              compositionHeight={composition.height}
              canvasDisplayWidth={canvasSize.width}
              canvasDisplayHeight={canvasSize.height}
              onCommit={onOverlayCommit ?? (() => {})}
              onCancel={onOverlayCancel ?? (() => {})}
            />
          )}
          {/* Point-text glyph-box handles (corner→fontSize, rotate, body-drag
              with frame/sibling snapping + guides) for a selected text overlay.
              Renders over the MEASURED box, NOT the stored rect. */}
          {transformSelectedOverlay &&
            showTransformUI &&
            isTextSelected &&
            canvasControl === "handles" &&
            editingOverlay?.id !== transformSelectedOverlay.id &&
            (canvasSize.width || 0) > 0 && (
              <OverlayHandles
                composition={composition}
                overlay={(transformDisplayOverlay ?? transformSelectedOverlay) as TextOverlay}
                canvasDisplayWidth={canvasSize.width}
                canvasDisplayHeight={canvasSize.height}
                getCanvasBounds={getCanvasBounds}
                snapEnabled={snapEnabled}
                locked={getOverlayLocked(transformSelectedOverlay.id)}
                siblingAnchorsX={siblingAnchorsX}
                siblingAnchorsY={siblingAnchorsY}
                onRequestEdit={() => onEditOverlay?.(transformSelectedOverlay.id)}
                onCommit={(patch) =>
                  onOverlayTransformCommit(transformSelectedOverlay.id, patch)
                }
                onFlush={() =>
                  onOverlayTransformFlush(transformSelectedOverlay.id)
                }
              />
            )}
          {/* 3D orbit gizmo for a selected 3D text caption (`threeD` set). A flat
              caption renders the 2D OverlayHandles above instead; the two are
              mutually exclusive via captionCanvasControl. */}
          {transformSelectedOverlay &&
            showTransformUI &&
            isTextSelected &&
            canvasControl === "gizmo" &&
            editingOverlay?.id !== transformSelectedOverlay.id &&
            (canvasSize.width || 0) > 0 && (
              <ThreeGizmoControls
                composition={composition}
                overlay={(transformDisplayOverlay ?? transformSelectedOverlay) as TextOverlay}
                canvasDisplayWidth={canvasSize.width}
                canvasDisplayHeight={canvasSize.height}
                getCanvasBounds={getCanvasBounds}
                snapEnabled={snapEnabled}
                siblingAnchorsX={siblingAnchorsX}
                siblingAnchorsY={siblingAnchorsY}
                onRequestEdit={() => onEditOverlay?.(transformSelectedOverlay.id)}
                locked={getOverlayLocked(transformSelectedOverlay.id)}
                onCommit={(patch) =>
                  onOverlayTransformCommit(transformSelectedOverlay.id, patch)
                }
                onFlush={() =>
                  onOverlayTransformFlush(transformSelectedOverlay.id)
                }
              />
            )}
          {/* Non-blocking readability hint: ANY selected 3D overlay tilted
              near edge-on is hard to read. Subtle warning pill pinned just above
              the overlay rect. `pointer-events:none` so it never intercepts the
              gizmo drag underneath. */}
          {transformSelectedOverlay &&
            showTransformUI &&
            canvasControl === "gizmo" &&
            // A `three` overlay's facing is camera/scene-driven (billboard), so the flat edge-on heuristic doesn't apply.
            transformSelectedOverlay.kind !== "three" &&
            isOverlayNearEdgeOn(
              resolveOverlayTransform(transformDisplayOverlay ?? transformSelectedOverlay),
            ) &&
            (canvasSize.width || 0) > 0 && (
              <div
                aria-hidden
                className="pointer-events-none absolute z-50 flex items-center gap-1 rounded bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-medium text-black shadow"
                style={{
                  left:
                    ((transformDisplayOverlay ?? transformSelectedOverlay).rect.x /
                      composition.width) *
                    (canvasSize.width || 1),
                  top:
                    ((transformDisplayOverlay ?? transformSelectedOverlay).rect.y /
                      composition.height) *
                      (canvasSize.height || 1) -
                    20,
                }}
              >
                <EyeOff className="h-3 w-3" />
                Facing away — tilt back to read
              </div>
            )}
          {/* Direct-manipulation transform frame for non-text overlays.
              Tracked overlays are EXCLUDED here — they get the dedicated
              TrackedTransformControls below, framed on the RESOLVED art box
              (the stored rect is not where tracked art renders for tight/head
              fits) with scale/spin handles instead of rect handles. */}
          {transformSelectedOverlay &&
            showTransformUI &&
            !isTextSelected &&
            transformSelectedOverlay.kind !== "tracked" &&
            canvasControl === "handles" &&
            (canvasSize.width || 0) > 0 && (
            <OverlayTransformControls
              composition={composition}
              overlay={transformDisplayOverlay ?? transformSelectedOverlay}
              canvasDisplayWidth={canvasSize.width}
              canvasDisplayHeight={canvasSize.height}
              getCanvasBounds={getCanvasBounds}
              locked={getOverlayLocked(transformSelectedOverlay.id)}
              onCommit={(patch) =>
                onOverlayTransformCommit(transformSelectedOverlay.id, patch)
              }
              onFlush={() =>
                onOverlayTransformFlush(transformSelectedOverlay.id)
              }
            />
          )}
          {/* Tracked overlay scale/spin handles — framed on the resolved art
              box (track sample + fit/scale + follow offset). Corner handles
              write the track-relative `scale`, the knob writes
              transform3d.rotation.z; the interior is click-through so the
              plain-drag reposition + "Adjust tracking" re-anchor gestures on
              the canvas are untouched. Hidden while the palette is open
              (adjust mode edits the TRACK, not the art), while the overlay is
              locked, and when the track has no visible sample at the playhead
              (nothing is painted to frame). */}
          {transformSelectedOverlay &&
            showTransformUI &&
            transformSelectedOverlay.kind === "tracked" &&
            !paletteOpen &&
            !getOverlayLocked(transformSelectedOverlay.id) &&
            (canvasSize.width || 0) > 0 &&
            (() => {
              const o = transformSelectedOverlay as TrackedOverlay;
              const tr = tracks[o.trackId] as Track | undefined;
              if (!tr) return null;
              const s = sampleTrackedOverlay(o, tr, composition.overlays, time);
              if (!s || !s.visible) return null;
              const art = resolveTrackedRect(s, o, {
                width: composition.width,
                height: composition.height,
              });
              return (
                <TrackedTransformControls
                  composition={composition}
                  overlay={o}
                  artRect={art}
                  canvasDisplayWidth={canvasSize.width}
                  canvasDisplayHeight={canvasSize.height}
                  getCanvasBounds={getCanvasBounds}
                  onCommit={(patch) => onOverlayTransformCommit(o.id, patch)}
                  onFlush={() => onOverlayTransformFlush(o.id)}
                />
              );
            })()}
          {/* 3D orbit gizmo for a selected NON-TEXT overlay in 3D mode
              (place3d image/video/code, or a `three` overlay). Mutually
              exclusive with the 2D OverlayTransformControls above via
              canvasControl — a flat non-text overlay shows its rect handles,
              a 3D one shows the orbit gizmo. (3D text uses the text-gizmo
              branch above.) Tracked is excluded outright: it always uses
              TrackedTransformControls, so an agent-set `place3d` on a tracked
              overlay can't double-mount the orbit gizmo alongside it. */}
          {transformSelectedOverlay &&
            showTransformUI &&
            !isTextSelected &&
            transformSelectedOverlay.kind !== "tracked" &&
            canvasControl === "gizmo" &&
            editingOverlay?.id !== transformSelectedOverlay.id &&
            (canvasSize.width || 0) > 0 && (
              <ThreeGizmoControls
                composition={composition}
                overlay={transformDisplayOverlay ?? transformSelectedOverlay}
                canvasDisplayWidth={canvasSize.width}
                canvasDisplayHeight={canvasSize.height}
                getCanvasBounds={getCanvasBounds}
                locked={getOverlayLocked(transformSelectedOverlay.id)}
                displayRect={
                  isOverlayIn3dMode(transformSelectedOverlay)
                    ? threeContentRects[transformSelectedOverlay.id]
                    : undefined
                }
                onCommit={(patch) =>
                  onOverlayTransformCommit(transformSelectedOverlay.id, patch)
                }
                onFlush={() =>
                  onOverlayTransformFlush(transformSelectedOverlay.id)
                }
              />
            )}
          {/* Drag affordance — a focus-frame sized to the tracked subject,
              GPU-transformed with easing so it glides smoothly with the cursor. */}
          {dragGhost && (canvasSize.width || 0) > 0 && (() => {
            const px = (dragGhost.x / composition.width) * (canvasSize.width || 1);
            const py = (dragGhost.y / composition.height) * (canvasSize.height || 1);
            return (
              <div
                aria-hidden
                className="pointer-events-none absolute left-0 top-0 will-change-transform"
                style={{
                  width: dragGhost.w,
                  height: dragGhost.h,
                  transform: `translate3d(${px - dragGhost.w / 2}px, ${py - dragGhost.h / 2}px, 0)`,
                  transition: "transform 90ms cubic-bezier(0.22, 1, 0.36, 1)",
                }}
              >
                <div className="absolute inset-0 rounded-xl bg-amber-400/10 ring-2 ring-amber-400/90 shadow-[0_0_22px_4px_rgba(251,191,36,0.35)] backdrop-blur-[1px]" />
                <span className="absolute -left-px -top-px h-3 w-3 rounded-tl-xl border-l-2 border-t-2 border-amber-200" />
                <span className="absolute -right-px -top-px h-3 w-3 rounded-tr-xl border-r-2 border-t-2 border-amber-200" />
                <span className="absolute -bottom-px -left-px h-3 w-3 rounded-bl-xl border-b-2 border-l-2 border-amber-200" />
                <span className="absolute -bottom-px -right-px h-3 w-3 rounded-br-xl border-b-2 border-r-2 border-amber-200" />
                <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-200 shadow-[0_0_8px_2px_rgba(251,191,36,0.6)]" />
              </div>
            );
          })()}
          {/* Overlay error badges — one per code/three overlay whose current
              source failed to compile. Positioned at the overlay rect's
              top-left using the same canvas-relative mapping the inline editor
              uses; the last-good render shows underneath (no blank flash). */}
          {overlayErrors && Object.keys(overlayErrors).length > 0 && (canvasSize.width || 0) > 0 &&
            (composition.overlays ?? []).map((o) => {
              const message = overlayErrors[o.id];
              if (!message) return null;
              const dispW = canvasSize.width || 1;
              const dispH = canvasSize.height || 1;
              const left = (o.rect.x / composition.width) * dispW;
              const top = (o.rect.y / composition.height) * dispH;
              return (
                <OverlayErrorBadge
                  key={o.id}
                  message={message}
                  style={{ left, top }}
                />
              );
            })}
          {/* Hover / "Adjust tracking" — plain static selection outline over
              the tracked overlay art (no animation). */}
          {(() => {
            if (!hoveredTrackedId && !showRevealOutline) return null;
            const dispW = canvasSize.width || 1;
            const dispH = canvasSize.height || 1;
            const time = frame / composition.fps;
            // Mirrors the TrackedTransformControls mount gate above: when the
            // amber gizmo frame is up for an overlay, drop this outline for it
            // so a selected tracked overlay shows exactly ONE box. (The gizmo's
            // remaining conditions — track exists + visible sample — are
            // re-checked per overlay below and null out both surfaces alike.)
            const gizmoUpFor = (id: string) =>
              transformSelectedOverlay?.id === id &&
              showTransformUI &&
              transformSelectedOverlay.kind === "tracked" &&
              !paletteOpen &&
              !getOverlayLocked(id) &&
              (canvasSize.width || 0) > 0;
            const revealOverlays = overlaysActiveAt(composition.overlays ?? [], time).filter(
              (o) =>
                o.kind === "tracked" &&
                (showRevealOutline || o.id === hoveredTrackedId) &&
                !gizmoUpFor(o.id),
            );
            return revealOverlays.map((o) => {
              if (o.kind !== "tracked") return null;
              const tr = tracks[o.trackId];
              if (!tr) return null;
              const s = sampleTrackedOverlay(o, tr, composition.overlays, time);
              if (!s || !s.visible) return null;
              // resolveTrackedRect (not applyFitAndScale): the outline must land
              // on the actual art, which includes the user's follow offset.
              const art = resolveTrackedRect(s, o, {
                width: composition.width,
                height: composition.height,
              });
              const left = (art.x / composition.width) * dispW;
              const top = (art.y / composition.height) * dispH;
              const width = (art.w / composition.width) * dispW;
              const height = (art.h / composition.height) * dispH;
              return (
                <div
                  key={o.id}
                  aria-hidden
                  className="pointer-events-none absolute rounded-sm border border-amber-400/70"
                  style={{ left, top, width, height }}
                />
              );
            });
          })()}
          {/* Buffering indicator — shown only while the readiness gate holds
              (playhead frozen). Subtle, centered, non-blocking; the canvas
              keeps showing the last good frame underneath so there's no torn
              or black flash. */}
          {buffering && (
            <div
              data-testid="preview-buffering-indicator"
              aria-live="polite"
              className="pointer-events-none absolute inset-0 flex items-center justify-center"
            >
              <div className="flex items-center gap-2 rounded-full bg-black/55 px-3 py-1.5 text-xs font-medium text-white/90 shadow-lg backdrop-blur-sm">
                <svg
                  className="h-3.5 w-3.5 animate-spin"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden
                >
                  <circle cx="8" cy="8" r="6" strokeOpacity="0.3" />
                  <path d="M8 2a6 6 0 0 1 6 6" strokeLinecap="round" />
                </svg>
                Buffering…
              </div>
            </div>
          )}
          {activeVideoErrors.length > 0 && (
            <div
              data-testid="preview-video-error-banner"
              role="alert"
              className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-2"
            >
              <div className="pointer-events-auto max-w-md rounded-md border border-destructive/60 bg-destructive/15 px-3 py-2 text-left shadow-lg backdrop-blur-sm">
                <div className="flex items-start gap-2">
                  <svg
                    className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    aria-hidden
                  >
                    <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM7.25 5a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-1.5 0V5zM8 11.25a.875.875 0 1 1 0-1.75.875.875 0 0 1 0 1.75z" />
                  </svg>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-destructive">
                      {activeVideoErrors.length === 1
                        ? `Can't play "${activeVideoErrors[0]!.name}"`
                        : `${activeVideoErrors.length} videos can't play`}
                    </p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-foreground/80">
                      {activeVideoErrors[0]!.message}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Effects picker panel — ABOVE the controls bar so the playback
          controls stay visible while it's open. */}
      {effectsPanelOpen && (
        <EffectsPanel
          pieceId={pieceId}
          composition={composition}
          selectionStore={selectionStore}
          effectHighlightStore={effectHighlightStore}
          effectPreviewStore={effectPreviewStore}
          keyframeSelectionStore={keyframeSelectionStore}
          readOnly={effectsReadOnly}
          onClose={onCloseEffectsPanel}
          onAddKeyframeAtPlayhead={onAddKeyframeAtPlayhead}
          familyRequest={familyRequest}
        />
      )}

      {/* Controls bar */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border bg-surface px-4 py-2">
        <button
          data-testid="preview-play"
          onClick={onPlayToggle}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded text-foreground transition-colors hover:bg-surface-hover"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <rect x="3" y="2" width="4" height="12" rx="1" />
              <rect x="9" y="2" width="4" height="12" rx="1" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 2.5a.5.5 0 0 1 .764-.424l8 5a.5.5 0 0 1 0 .848l-8 5A.5.5 0 0 1 4 12.5v-10z" />
            </svg>
          )}
        </button>

        <span
          data-testid="frame-counter"
          className="min-w-[7rem] shrink-0 whitespace-nowrap font-mono text-xs text-muted-foreground tabular-nums"
        >
          {frame} / {totalFrames}
        </span>

        <div className="flex-1" />

        <MasterVolumeControl
          volume={masterVolume}
          muted={masterMuted}
          onVolumeChange={onMasterVolumeChange}
          onToggleMuted={onToggleMasterMuted}
        />

        <div className="flex items-center gap-1">
          {[0.5, 1, 2].map((s) => (
            <button
              key={s}
              onClick={() => onSpeedChange(s)}
              className={`cursor-pointer rounded px-2 py-1 text-xs font-medium transition-colors ${
                speed === s
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {s}x
            </button>
          ))}
        </div>

        <button
          type="button"
          data-testid="toggle-snap"
          onClick={onToggleSnap}
          aria-pressed={snapEnabled}
          title={snapEnabled ? "Snapping on (Alt to bypass)" : "Snapping off"}
          className={`cursor-pointer rounded px-2 py-1 text-xs font-medium transition-colors ${
            snapEnabled
              ? "bg-primary/20 text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Snap
        </button>

        <button
          type="button"
          data-testid="toggle-effects-panel"
          onClick={onToggleEffectsPanel}
          className={`cursor-pointer rounded px-2 py-1 text-xs font-medium transition-colors ${
            effectsPanelOpen
              ? "bg-primary/20 text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Effects
        </button>
      </div>

    </div>
  );
}
