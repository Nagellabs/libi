"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { pieceKeys } from "@/lib/queries/pieces";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import { useEditorState } from "@/lib/editor-state-context";
import LayersInspectorPanel from "@/components/preview/layers-inspector-panel";
import type { AudioClip, Composition, TextOverlay } from "@/lib/engine/types";
import type { FileRecord } from "@/lib/db/schema/types";
import { useWebAudioMaster } from "@/hooks/preview/use-web-audio-master";
import { useTransport } from "@/hooks/preview/use-transport";
import { usePreviewAssets } from "@/hooks/editor/use-preview-assets";
import { readyAhead, type VideoFrameSource } from "@/lib/engine/video-frame-source";
import { computeVideoPriorities } from "@/lib/preview/track-priority";
import { computeReadyState, type ReadyDecision } from "@/lib/preview/ready-state";
import {
  hiddenIdSetFromSignature,
  hiddenIdSignature,
  stripHiddenAudioClips,
  stripNonDecodingOverlays,
} from "@/lib/overlays/hidden";
import PreviewPlayer from "@/components/preview/preview-player";
import type { EffectsFamily } from "@/components/preview/effects-panel";
import Timeline from "@/components/preview/timeline";
// NOTE: all three menu/dialog components are DEFAULT exports.
import AudioClipContextMenu from "@/components/preview/audio-clip-context-menu";
import OverlayClipContextMenu from "@/components/preview/overlay-clip-context-menu";
import KeyframeContextMenu from "@/components/preview/keyframe-context-menu";
import { useClipOps } from "@/lib/queries/clips";
import DuckConfigDialog from "@/components/preview/duck-config-dialog";
import { AudioLengthDialog } from "@/components/preview/audio-length-dialog";
import { useUpdateAudioClip, useAddAudioClip } from "@/lib/queries/audio-clips";
import { overlayErrorEmitter } from "@/hooks/sessions/use-agent-chat";
import type { UseExportFlowResult } from "@/hooks/editor/use-export-flow";
import { createSelectionStore, type SelectionStore } from "@/lib/preview/selection-store";
import {
  createKeyframeSelectionStore,
  keyframeSelectionKey,
  type KeyframeSelectionStore,
} from "@/lib/preview/keyframe-selection-store";
import { useSelectedKeyframe } from "@/hooks/preview/use-selected-keyframe";
import { useKeyframeOps } from "@/lib/queries/keyframes";
import { overlayKeyframeTimes } from "@/lib/overlays/keyframes";
import { createOverlayEditStore } from "@/lib/preview/overlay-edit-store";
import { OverlayEditStoreProvider } from "@/lib/preview/overlay-edit-context";
import { useMergedOverlayEdits } from "@/hooks/preview/use-overlay-edits";
import { useHighlight } from "@/hooks/preview/use-highlight";
import { useEffectHighlight } from "@/hooks/preview/use-effect-highlight";
import { useRegisterCustomEffects } from "@/hooks/preview/use-register-custom-effects";
import {
  useOverlayTransformCommit,
  type OverlayTransformPatch,
} from "@/hooks/editor/use-overlay-transform-commit";
import { trackEvent } from "@/lib/analytics/client";
import { buildLayersViewModel } from "@/lib/overlays/layers-view-model";
import { reorderZByDrag } from "@/lib/preview/track-stack-view-model";
import { overlayTrackLabel, overlayTrackTooltip } from "@/lib/preview/track-labels";
import { useAddOverlay } from "@/lib/queries/overlays";
import { useFileUpload } from "@/lib/queries/files";
import { OverlayAssetPicker } from "@/components/preview/overlay-asset-picker";
import {
  defaultOverlayInit,
  type NewOverlayPayload,
} from "@/lib/overlays/new-overlay-defaults";
import { OverlayAgentDialog } from "@/components/preview/overlay-agent-dialog";
import { buildCreatePrompt, buildModifyPrompt, buildTranscribePrompt } from "@/lib/overlays/agent-prompt";
import { frameToTimecode } from "@/lib/preview/timecode";
import { useEffectPreviewStore } from "@/lib/preview/effect-preview-store";
import { playWindowOnce } from "@/lib/preview/play-window-once";
import { EFFECT_PREVIEW_SETTLE_MS } from "@/lib/preview/tuning";

// Stable empty reference so `composition?.audioClips ?? EMPTY_AUDIO_CLIPS` does
// not allocate a new array on every 30 Hz render when a comp has no clips.
const EMPTY_AUDIO_CLIPS: AudioClip[] = [];

interface PendingSeek {
  pieceId: string;
  sceneId: string;
}

export interface PreviewSurfaceProps {
  composition: Composition | null;
  totalFrames: number;
  pieceId: string;
  pieceName: string | null;
  files: FileRecord[];
  exportFlow: UseExportFlowResult;
  hasSnapshot: boolean;
  hasDraft: boolean;
  /** Inline overlay-edit wiring (owned by the editor page's useOverlayEditing). */
  editingOverlay: TextOverlay | null;
  onEditOverlay: (id: string) => void;
  onOverlayCommit: (content: string) => void;
  onOverlayCancel: () => void;
  /** A pending navigation seek (set by show_scene/show_preview); consumed once. */
  pendingSeek: PendingSeek | null;
  /** True while the active piece's composition query is refetching — the
   *  auto-show seek waits for this to settle (behavior parity with the editor page). */
  isCompositionFetching: boolean;
  onPendingSeekConsumed: () => void;
}

/**
 * The self-contained preview/playback unit. Owns the audio engine, the
 * transport (whose playhead lives in a FrameStore), the preview asset hooks,
 * the dev probe, seek helpers, timeline-marker state, and the scene/audio-clip
 * context menus — everything that used to be inline in the editor page and
 * forced it to re-render 30x/sec. Only this subtree touches the frame; the
 * editor page above it never does.
 *
 * This component itself re-renders at the playhead rate (it reads `frame` for
 * the source-budget planner), but its render allocates nothing per frame:
 * Timeline's props are memoized below, and the page ABOVE this component reads
 * the frame nowhere, so it never re-renders per frame. PreviewPlayer and
 * Timeline each subscribe to the frame directly via `usePlaybackFrame`, so they
 * repaint at 30 Hz in isolation; Timeline's `React.memo` additionally bails on
 * this component's non-frame (e.g. composition-refetch) re-renders.
 */
export default function PreviewSurface({
  composition,
  totalFrames,
  pieceId,
  pieceName,
  files,
  exportFlow,
  hasSnapshot,
  hasDraft,
  editingOverlay,
  onEditOverlay,
  onOverlayCommit,
  onOverlayCancel,
  pendingSeek,
  isCompositionFetching,
  onPendingSeekConsumed,
}: PreviewSurfaceProps) {
  // Audio-master engine + transport (playhead in a FrameStore).
  const { control: audioMasterControl, engineRef: audioEngineRef } = useWebAudioMaster();

  // ── Decode-readiness probe (backpressure) ────────────────────────────────
  // The audio-master clock advances on its own; this probe is how the transport
  // learns whether the video has the pixels yet. It returns the MIN decoded
  // runway (seconds) across every video source ACTIVE at composition-second `t`,
  // or `Infinity` when nothing gates (pure canvas comp). A source that can't even
  // serve a live frame at `t` returns a negative runway so the gate trips
  // decisively. Built stable (empty deps) and reads the latest sources +
  // composition from a ref updated after usePreviewAssets — useTransport is
  // called BEFORE the assets hook, so the ref bridges the cycle.
  const readyProbeRef = useRef<{
    sources: Record<string, VideoFrameSource>;
    composition: Composition | null;
  }>({ sources: {}, composition: null });
  const getReadyAhead = useCallback((t: number): ReadyDecision => {
    const { sources, composition: comp } = readyProbeRef.current;
    if (!comp) return { allCanPaint: true, dominantId: null, dominantRunway: Infinity };
    const compArea = Math.max(1, comp.width * comp.height);

    // One entry per ACTIVE video source at `t`, carrying both its paint/runway
    // state (for the gate/re-buffer decision) and its geometry (for priority).
    interface Active {
      id: string;
      area: number; // on-screen area fraction 0..1
      z: number;
      opacity: number;
      duration: number;
      canPaint: boolean;
      runway: number;
    }
    const actives: Active[] = [];
    const consider = (
      id: string,
      src: VideoFrameSource | undefined,
      localT: number,
      area: number,
      z: number,
      opacity: number,
      duration: number,
    ) => {
      // An ACTIVE video whose source isn't registered yet (the startup race right
      // after a piece loads / a source attaches) must read as BLACK (canPaint
      // false) so the gate HOLDS — otherwise the first getFrame hits an empty ring
      // with no last-good frame → a BLACK flash (the count-0-but-black cold start).
      if (!src) {
        actives.push({ id, area, z, opacity, duration, canPaint: false, runway: -1 });
        return;
      }
      // No live frame at the playhead = the exact condition that snaps a frame →
      // negative runway. But if the source has a last-good it can still PAINT
      // (hold) without going black — that distinction is what lets a secondary
      // drop frames without re-buffering the comp.
      const live = src.isReadyAt ? src.isReadyAt(localT) : true;
      const runway = live ? readyAhead(src, localT) : -1;
      const canPaint = live || src.lastGoodFrame?.() != null;
      actives.push({ id, area, z, opacity, duration, canPaint, runway });
    };
    // Sequential video scenes (source-local time = trim.start + offset). A base
    // scene is full-frame (area 1) and sits BEHIND overlays (z -1).
    // Scenes are canvas-only and decode no video — every gated source is an
    // overlay.
    // Video / tracked-video overlays. Include trim.start for `video` so the gate
    // probes the SAME source-time the renderer draws + warm() decodes — else a
    // trimmed/cut clip reads not-ready at its real in-point and the gate holds (the
    // mid-play buffer at a cut). Tracked-video draws at absolute time (no trim).
    for (const o of comp.overlays ?? []) {
      const area = Math.max(0, Math.min(1, (o.rect.width * o.rect.height) / compArea));
      if (o.kind === "video") {
        if (t < o.startTime || t >= o.startTime + o.duration) continue;
        consider(o.id, sources[o.id], t - o.startTime + (o.trim?.start ?? 0), area, o.z, o.opacity, o.duration);
      } else if (o.kind === "tracked" && o.content.kind === "video") {
        if (t < o.startTime || t >= o.startTime + o.duration) continue;
        consider(o.id, sources[o.id], t - o.startTime, area, o.z, o.opacity, o.duration);
      }
    }

    if (actives.length === 0) {
      return { allCanPaint: true, dominantId: null, dominantRunway: Infinity };
    }
    // Score by visibility (area/z/duration/opacity) so the gate + re-buffer key
    // off the DOMINANT (most-visible) source — the drop-frames model.
    const priorities = computeVideoPriorities(
      actives.map((a) => ({ id: a.id, areaFraction: a.area, z: a.z, opacity: a.opacity, durationSec: a.duration })),
    );
    return computeReadyState(
      actives.map((a) => ({ id: a.id, canPaint: a.canPaint, runway: a.runway, priority: priorities.get(a.id) ?? 0 })),
    );
  }, []);

  const transport = useTransport({
    totalFrames,
    fps: composition?.fps ?? 30,
    audioMaster: audioMasterControl,
    getReadyAhead,
  });

  // NOTE: this component deliberately does NOT subscribe to the live frame. The
  // source-budget planner needs the moving playhead, but it consumes it by
  // SUBSCRIBING to `transport.frameStore` imperatively inside `useVideoSources`
  // (applyBudget is a side-effect, no React output) — so PreviewSurface and its
  // whole subtree (the inspector!) never reconcile per frame. PreviewPlayer and
  // Timeline subscribe to the frame directly via `usePlaybackFrame`, so only they
  // re-render at 30 Hz. Reading the frame HERE was the measured cause of the
  // post-edit GC stutter (the inspector's base-ui fields reconciling 30 Hz while
  // an overlay was selected). See docs-local/superpowers/notes/smoothness-fixture.md.

  // Hydrate the shared effect registry with custom packages ONCE, high in the
  // tree, so the effects picker derives them through listEffects() on first open.
  useRegisterCustomEffects();

  // Single-select overlay id, held OUTSIDE React so selecting never re-renders
  // the editor page (mirrors the FrameStore). Created once.
  const selectionStoreRef = useRef<SelectionStore | null>(null);
  if (selectionStoreRef.current === null) selectionStoreRef.current = createSelectionStore();
  const selectionStore = selectionStoreRef.current;

  // Selected keyframe `{ overlayId, t }` — held OUTSIDE React (mirrors the
  // selection/frame stores). Set on a diamond click; Phase 6's curve editor
  // consumes it. Created once.
  const keyframeSelectionStoreRef = useRef<KeyframeSelectionStore | null>(null);
  if (keyframeSelectionStoreRef.current === null) {
    keyframeSelectionStoreRef.current = createKeyframeSelectionStore();
  }
  const keyframeSelectionStore = keyframeSelectionStoreRef.current;
  const selectedKeyframe = useSelectedKeyframe(keyframeSelectionStore);
  const keyframeOps = useKeyframeOps(pieceId);
  // Clicking a diamond selects that keyframe AND its overlay (so the inspector
  // follows). stopPropagation in the bar keeps it from starting a bar drag.
  const handleSelectKeyframe = useCallback(
    (overlayId: string, t: number) => {
      keyframeSelectionStore.set({ overlayId, t });
      selectionStore.set(overlayId);
      // Land the playhead EXACTLY on the selected keyframe's frame so a
      // subsequent transform edit UPDATES this keyframe (snap-to-keyframe)
      // instead of creating a new one a hair away.
      const ov = composition?.overlays?.find((o) => o.id === overlayId);
      if (ov) {
        const fps = composition?.fps ?? 30;
        transport.seek(Math.round((ov.startTime + t * ov.duration) * fps));
      }
    },
    [keyframeSelectionStore, selectionStore, composition, transport],
  );
  // Auto-open (D5): when a keyframe becomes newly selected (diamond click or a
  // just-added keyframe), open the Effects panel — the EffectsPanel switches its
  // own family tab to "Keyframes". Keyed on the selection identity so it only
  // fires on a NEW selection, never re-opening a panel the user just closed.
  const lastAutoOpenedKeyframe = useRef<string | null>(null);

  // ── Inline overlay-edit store (Layer 0) ──────────────────────────────
  // ONE store owned here; later tasks (drag handles, gizmo, transform commit,
  // inspector) write pending edits to it so the canvas paints them before the
  // server round-trip lands. The merged composition is the server composition
  // with those pending edits applied — identity-stable while the store is
  // empty, so this is behavior-neutral until later tasks write to it.
  // NO rAF scheduler — gesture `preview()` writes paint the canvas
  // SYNCHRONOUSLY so a dragged overlay tracks the pointer 1:1 (Excalidraw-style),
  // with zero frame lag. The previous rAF coalescing trailed the pointer by up to
  // one frame, which is invisible on a slow drag but, on a fast "throw" (releasing
  // while moving fast), left a release-velocity-proportional catch-up lurch as the
  // overlay snapped to the committed spot. Coalescing only ever existed to avoid
  // double-paints during the old dual-store (drag + edit) transition; that store
  // is gone, so synchronous paint is the correct default. A canvas draw is ~0.4ms
  // and the paint stays imperative-only, so neither perf nor frame-isolation
  // regresses. (The `scheduler` option is retained on the store for tests + any
  // future high-frequency writer that genuinely needs batching.)
  const queryClient = useQueryClient();
  const overlayEditStore = useRef(createOverlayEditStore()).current;
  const mergedComposition = useMergedOverlayEdits(composition, overlayEditStore);

  // Timeline bar labels (kind + display name / text content / file name) AND
  // the rich rail-icon tooltips (full, uncapped name + attached-audio note).
  // Built here because they need file records (image/video names). See
  // track-labels.ts.
  const { overlayLabelById, railTooltipById } = useMemo(() => {
    const byId = new Map(files.map((f) => [f.id, f] as const));
    const coupled = new Set(
      (mergedComposition?.audioClips ?? [])
        .filter((c) => c.kind === "inline" && c.linkedOverlayId)
        .map((c) => c.linkedOverlayId as string),
    );
    const labels: Record<string, string> = {};
    const tips: Record<string, string> = {};
    for (const o of mergedComposition?.overlays ?? []) {
      const fileId = o.kind === "image" || o.kind === "video" ? o.fileId : undefined;
      const file = fileId ? byId.get(fileId) : undefined;
      const fname = file ? file.name || file.filename : undefined;
      labels[o.id] = overlayTrackLabel(o, fname);
      tips[o.id] = overlayTrackTooltip(o, fname, coupled.has(o.id));
    }
    return { overlayLabelById: labels, railTooltipById: tips };
  }, [mergedComposition?.overlays, mergedComposition?.audioClips, files]);

  // ── Add-overlay create host (single owner; mounted into the Layers header
  //    AND the timeline track-stack header) ──────────────────────────────
  const addOverlay = useAddOverlay(pieceId, selectionStore);
  const [assetKind, setAssetKind] = useState<null | "image" | "video">(null);
  const resolveCtx = useCallback(() => {
    const fps = composition?.fps ?? 30;
    const startTime = transport.getFrame() / fps;
    const width = composition?.width ?? 1920;
    const height = composition?.height ?? 1080;
    const overlays = composition?.overlays ?? [];
    const z = overlays.length > 0 ? Math.max(0, ...overlays.map((o) => o.z)) + 1 : 0;
    // Timeline length in seconds — used to keep a new overlay inside the video
    // (never added past the end; anchored to the last section when near it).
    const totalDuration = totalFrames > 0 ? totalFrames / fps : 0;
    return { startTime, width, height, z, totalDuration };
  }, [composition?.fps, composition?.width, composition?.height, composition?.overlays, totalFrames, transport]);
  // Bounded-enum analytics for UI-initiated overlay creation. method ∈
  // "picker" | "drag" | "inline-caption"; kind ∈ "text" | "image" | "video".
  // NEVER pass file names / ids / user text here.
  const track = useCallback(
    (method: "picker" | "drag" | "inline-caption", kind: "text" | "image" | "video") =>
      trackEvent("overlay_added", { method, kind }),
    [],
  );
  const onCreateDirect = useCallback(
    (payload: NewOverlayPayload) => {
      track("picker", payload.kind);
      addOverlay.mutate(payload);
    },
    [addOverlay, track],
  );
  const onPickAsset = useCallback((kind: "image" | "video") => setAssetKind(kind), []);

  // ── Ask-agent composer (editable prompt dialog) ──────────────────────
  const [agentPrompt, setAgentPrompt] = useState<string | null>(null);
  const onAskAgent = useCallback(
    (kind: "code" | "three" | "tracked") => {
      const fps = composition?.fps ?? 30;
      const frame = transport.getFrame();
      setAgentPrompt(
        buildCreatePrompt(kind, "", {
          startTime: frame / fps,
          timecode: frameToTimecode(frame, fps),
        }),
      );
    },
    [composition?.fps, transport],
  );
  const onAskAgentModify = useCallback(
    (overlay: { id: string; kind: string; content?: string }) => {
      setAgentPrompt(buildModifyPrompt(overlay, ""));
    },
    [],
  );
  const onTranscribeAudio = useCallback(
    (audio: { fileId: string; fileName: string; label?: string }) => {
      setAgentPrompt(buildTranscribePrompt(audio));
    },
    [],
  );

  // ── Timeline lane drop → create image/video overlay ──────────────────
  // Dropping an in-app asset or an OS/Finder file on an OVERLAY lane creates
  // an image/video overlay at the drop x-position. `startTime`/`z`/`group`
  // are resolved per-lane by the row (via resolveDrop); width/height come
  // from the composition frame size.
  const { upload: uploadFile } = useFileUpload(pieceId);
  const frameSize = useMemo(
    () => ({ width: composition?.width ?? 1920, height: composition?.height ?? 1080 }),
    [composition?.width, composition?.height],
  );
  const durationSec = useMemo(
    () => (totalFrames > 0 ? totalFrames / (composition?.fps ?? 30) : 0),
    [totalFrames, composition?.fps],
  );
  const onDropCreate = useCallback(
    ({
      kind,
      fileId,
      startTime,
      z,
      group,
    }: {
      kind: "image" | "video";
      fileId: string;
      startTime: number;
      z: number;
      group?: string;
    }) => {
      track("drag", kind);
      addOverlay.mutate(
        defaultOverlayInit(kind, {
          startTime,
          width: frameSize.width,
          height: frameSize.height,
          z,
          totalDuration: durationSec,
          fileId,
          group,
        }),
      );
    },
    [addOverlay, frameSize.width, frameSize.height, durationSec, track],
  );
  const onDropFiles = useCallback(
    async (
      file: File,
      {
        kind,
        startTime,
        z,
        group,
      }: { kind: "image" | "video"; startTime: number; z: number; group?: string },
    ) => {
      try {
        const rec = await uploadFile(file);
        track("drag", kind);
        addOverlay.mutate(
          defaultOverlayInit(kind, {
            startTime,
            width: frameSize.width,
            height: frameSize.height,
            z,
            totalDuration: durationSec,
            fileId: rec.id,
            group,
          }),
        );
      } catch (err) {
        // Nothing else reports this. The comment here used to claim the upload
        // hook surfaced a toast; it does not, so a rejected drop onto the
        // timeline was entirely silent — no overlay, no message.
        toast.error(err instanceof Error ? err.message : "Upload failed");
      }
    },
    [addOverlay, uploadFile, frameSize.width, frameSize.height, durationSec, track],
  );

  // Dropped AUDIO → a standalone audio clip (not an overlay). In-app asset →
  // fileId; OS file → upload first (proxy auto via storeFile), then add.
  const addAudioClip = useAddAudioClip(pieceId);
  // An asset that would run past the piece's current end silently stretches
  // it otherwise — the user must choose (extend / trim / a specific length)
  // before the clip is written. Held here rather than fired immediately;
  // AudioLengthDialog below resolves it into the actual mutation.
  const [pendingAudioDrop, setPendingAudioDrop] = useState<{
    fileId: string;
    startTime: number;
    assetName: string;
    assetDurationSec: number;
  } | null>(null);
  const filesById = useMemo(() => new Map(files.map((f) => [f.id, f] as const)), [files]);
  const onDropAudio = useCallback(
    async (arg: { fileId?: string; file?: File; startTime: number }) => {
      let fileId = arg.fileId;
      let rec: FileRecord | undefined;
      if (!fileId && arg.file) {
        try {
          rec = await uploadFile(arg.file);
          fileId = rec.id;
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Upload failed");
          return;
        }
      }
      if (!fileId) return;
      const meta = rec ?? filesById.get(fileId);
      const assetDurationSec = meta?.mediaDuration ?? 0;
      if (durationSec > 0 && arg.startTime + assetDurationSec > durationSec) {
        setPendingAudioDrop({
          fileId,
          startTime: arg.startTime,
          assetName: meta ? meta.name || meta.filename : "This clip",
          assetDurationSec,
        });
        return;
      }
      addAudioClip.mutate({ fileId, startTime: arg.startTime });
    },
    [addAudioClip, uploadFile, durationSec, filesById],
  );

  // Just-created overlay id → drives the timeline bar's one-shot enter animation.
  // Reads the last successful create result; clears after the animation window.
  const justAddedOverlayId = addOverlay.data ?? null;
  const [justAddedId, setJustAddedId] = useState<string | null>(null);
  useEffect(() => {
    if (!justAddedOverlayId) return;
    setJustAddedId(justAddedOverlayId);
    const t = setTimeout(
      () => setJustAddedId((cur) => (cur === justAddedOverlayId ? null : cur)),
      600,
    );
    return () => clearTimeout(t);
  }, [justAddedOverlayId]);

  // Phase 5b AUTO-KEYFRAMING: once an overlay is animated (≥1 keyframe), a manual
  // rect / opacity / transform3d edit becomes a keyframe upsert at the playhead
  // rather than a flat base-field write. The playhead is read IMPERATIVELY here
  // (transport.getFrame()) — no per-frame subscription. `resolveOverlay` reads
  // the SERVER composition (where keyframes + startTime/duration live).
  const autoKeyframeConfig = useMemo(
    () => ({
      resolveOverlay: (overlayId: string) =>
        composition?.overlays?.find((o) => o.id === overlayId),
      playheadTime: () => transport.getFrame() / (composition?.fps ?? 30),
      addKeyframe: (overlayId: string, time: number, properties: Record<string, unknown>) => {
        keyframeOps.add.mutate({ overlayId, time, properties });
      },
    }),
    [composition?.overlays, composition?.fps, transport, keyframeOps.add],
  );

  const { commit: commitOverlayTransform, flush: flushOverlayTransform } =
    useOverlayTransformCommit(pieceId, overlayEditStore, autoKeyframeConfig);
  const handleOverlayTransformCommit = useCallback(
    (overlayId: string, patch: OverlayTransformPatch) => {
      const kind = composition?.overlays?.find((o) => o.id === overlayId)?.kind ?? "text";
      // A transform3d-only patch is a rotate; a rect patch is a move-or-resize.
      const op = patch.transform3d !== undefined && !patch.rect ? "rotate" : "transform";
      trackEvent("overlay_edited", { kind, op });
      void commitOverlayTransform(overlayId, patch);
    },
    [composition?.overlays, commitOverlayTransform],
  );
  // Task 9: pointer-up forces the trailing-debounced PATCH NOW (one PATCH per
  // gesture). The per-move `commit` already painted the final value via the
  // edit store; flush just persists the coalesced patch immediately.
  const handleOverlayTransformFlush = useCallback(
    (overlayId: string) => {
      flushOverlayTransform(overlayId);
    },
    [flushOverlayTransform],
  );

  // ── Layers + timeline resizable layout state ─────────────────────────
  const {
    viewMode,
    previewQuality,
    previewTimelineSplit,
    setPreviewTimelineSplit,
    getOverlayLocked,
    setOverlayLocked,
    previewLayersSplit,
    setPreviewLayersSplit,
    getPreviewLayersDocked,
    setPreviewLayersDocked,
    sessionList,
    chatVisible,
    toggleChat,
    setOverlayInspectorMode,
    effectsPanelOpen,
    setEffectsPanelOpen,
    snapEnabled,
    setSnapEnabled,
  } = useEditorState();

  // External "open the effects picker on this family" request. Bumping the nonce
  // re-triggers the panel's tab switch even for the same family.
  const [effectsFamilyRequest, setEffectsFamilyRequest] = useState<{
    family: EffectsFamily;
    nonce: number;
  } | null>(null);
  const onOpenEffects = useCallback((family?: EffectsFamily) => {
    setEffectsPanelOpen(true);
    if (family) setEffectsFamilyRequest((r) => ({ family, nonce: (r?.nonce ?? 0) + 1 }));
  }, [setEffectsPanelOpen]);

  // Auto-open the Effects panel on a NEW keyframe selection (see the ref above).
  const selectedKeyframeKey = keyframeSelectionKey(selectedKeyframe) || null;
  useEffect(() => {
    if (selectedKeyframeKey && selectedKeyframeKey !== lastAutoOpenedKeyframe.current) {
      lastAutoOpenedKeyframe.current = selectedKeyframeKey;
      setEffectsPanelOpen(true);
    }
    if (!selectedKeyframeKey) lastAutoOpenedKeyframe.current = null;
  }, [selectedKeyframeKey, setEffectsPanelOpen]);

  // Non-decoding overlays — hidden layers (overlay.hidden, the persisted eye
  // toggle) and confirmed-missing VIDEO sources (overlay.missing, set by
  // buildComposition when the fileId is in neither piece nor global files) —
  // are excluded from the DECODE pipeline (video sources, budget, readiness
  // gate) the same way render skips/placeholder-paints them, so an overlay the
  // renderer never advances can never gate/re-buffer playback (see
  // stripNonDecodingOverlays for the full why). The RENDER path keeps reading
  // mergedComposition so a missing overlay's placeholder still paints. Merged
  // comp so an optimistic eye toggle takes effect immediately.
  const decodeComposition = useMemo(
    () => stripNonDecodingOverlays(mergedComposition),
    [mergedComposition],
  );

  // Guided-edit highlight store + apply (select overlay, switch THAT overlay's
  // inspector tab, flash field) driven by the agent's highlight_property /
  // set_complexity_mode tools. Mode is per-overlay.
  const highlightStore = useHighlight({
    pieceId,
    selectionStore,
    composition,
    setOverlayInspectorMode,
  });
  // Effects picker highlight store (catalog flash → opens the panel; applied
  // flash → selects the layer). Driven by the agent's highlight_effect tool.
  const effectHighlightStore = useEffectHighlight({
    pieceId,
    selectionStore,
    setEffectsPanelOpen,
  });
  // Effect-preview-on-select store: the Effects panel requests a window to play
  // when a layer effect / reveal mode is selected (nonce-driven → re-select
  // replays). Consumed by the subscription effect below.
  const effectPreviewStore = useEffectPreviewStore();
  // Snapshot view is read-only: drop-create + inline caption must be inert.
  const overlaysReadOnly = viewMode === "snapshot";

  // ── Layers/inspector panel (third docked panel) ──
  // Same docked-collapse-to-0 pattern as the details panel so PreviewPlayer is
  // never remounted: the layers Panel stays mounted and the group's layout is
  // driven imperatively via setLayout (main:100/layers:0 when undocked).
  const layersDocked = getPreviewLayersDocked(pieceId);
  const toggleLayers = useCallback(() => {
    setPreviewLayersDocked(pieceId, !getPreviewLayersDocked(pieceId));
  }, [pieceId, getPreviewLayersDocked, setPreviewLayersDocked]);
  const layersGroupRef = useGroupRef();
  const layersSplitRef = useRef(previewLayersSplit);
  layersSplitRef.current = previewLayersSplit;
  useEffect(() => {
    layersGroupRef.current?.setLayout(
      layersDocked
        ? { main: layersSplitRef.current, layers: 100 - layersSplitRef.current }
        : { main: 100, layers: 0 },
    );
  }, [layersDocked, layersGroupRef]);
  const handleLayersLayoutChanged = useCallback(
    (layout: { [id: string]: number }) => {
      const main = layout.main;
      if (typeof main === "number" && main > 5 && main < 95) setPreviewLayersSplit(main);
    },
    [setPreviewLayersSplit],
  );

  const handleTimelineLayoutChanged = useCallback(
    (layout: { [id: string]: number }) => {
      const top = layout.top;
      if (typeof top === "number" && top > 5 && top < 95) {
        setPreviewTimelineSplit(top);
      }
    },
    [setPreviewTimelineSplit],
  );

  const {
    videoSources,
    videoErrors,
    images: overlayImages,
    compiledDrawFns: overlayCompiledFns,
    codeContentBoxes: overlayCodeContentBoxes,
    threeScenes: overlayThreeScenes,
    spatialQuads: overlaySpatialQuads,
    overlayErrors: compileErrors,
    fontsVersion,
  } = usePreviewAssets(
    // Decode pipeline sees the non-decoding-filtered comp: useVideoSources'
    // registry rebuild disposes a just-hidden (or missing-file) video's decoder
    // (reconcileMounts' far-set path) instead of leaving it mounted, parked,
    // and gating the transport.
    decodeComposition,
    transport.playing,
    transport.speed,
    transport.frameStore,
    transport.seekSignal,
  );

  // Feed the latest sources + composition to the (stable) readiness probe the
  // transport holds. Done in an effect (not render-phase ref mutation) — the
  // probe is only invoked from the rAF tick / gate timers, long after commit, so
  // it always sees the freshest snapshot here. Uses decodeComposition so the
  // gate / dominance math only grades sources that are actually painted.
  useEffect(() => {
    readyProbeRef.current = { sources: videoSources, composition: decodeComposition };
  }, [videoSources, decodeComposition]);

  // overlay_error SSE state — per-overlay validation errors pushed by the
  // server-side storage watcher the instant an agent saves broken overlay
  // code, BEFORE the client has refetched + recompiled the composition.
  // Scoped to THIS piece. Once the preview recompiles the overlay cleanly
  // (it appears in compiledDrawFns/threeScenes and is absent from the
  // Task-12 compileErrors map) the SSE error is cleared — a subsequent
  // successful compile wins. A still-broken overlay shows the (fresher)
  // compileErrors message via the union below.
  const [sseOverlayErrors, setSseOverlayErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    const unsub = overlayErrorEmitter.on((e) => {
      if (e.pieceId !== pieceId) return;
      setSseOverlayErrors((prev) => ({ ...prev, [e.overlayId]: e.message }));
    });
    return unsub;
  }, [pieceId]);
  // Reset SSE errors when switching pieces (stale ids from another piece).
  useEffect(() => {
    setSseOverlayErrors({});
  }, [pieceId]);
  // Drop any SSE error for an overlay that has since recompiled cleanly:
  // present in the compiled output AND not flagged by the compile-error map.
  useEffect(() => {
    setSseOverlayErrors((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [id, msg] of Object.entries(prev)) {
        const compiledClean =
          (overlayCompiledFns[id] != null || overlayThreeScenes[id] != null) &&
          compileErrors[id] == null;
        if (compiledClean) {
          changed = true;
        } else {
          next[id] = msg;
        }
      }
      return changed ? next : prev;
    });
  }, [overlayCompiledFns, overlayThreeScenes, compileErrors]);

  // Union: SSE errors (early signal) + compile errors (post-recompile, fresher
  // message + authoritative for still-broken overlays). Restricted to live
  // overlays so a removed overlay's stale error never lingers.
  const overlayErrors = useMemo(() => {
    const live = new Set((composition?.overlays ?? []).map((o) => o.id));
    const merged: Record<string, string> = {};
    for (const [id, msg] of Object.entries(sseOverlayErrors)) {
      if (live.has(id)) merged[id] = msg;
    }
    for (const [id, msg] of Object.entries(compileErrors)) {
      if (live.has(id)) merged[id] = msg;
    }
    return merged;
  }, [sseOverlayErrors, compileErrors, composition?.overlays]);

  const masterOutputVolume = transport.masterMuted ? 0 : transport.masterVolume;
  // A hidden overlay's COUPLED inline audio must not sound (eye toggle = layer
  // OFF everywhere). Detached/standalone clips are independent and keep playing.
  // Hidden state comes from the MERGED overlays so an optimistic eye toggle
  // mutes instantly — but the memo is keyed on a STABLE primitive signature of
  // the hidden set, NOT the overlays array identity: overlay edits/drags churn
  // that identity on every commit, and depending on it would hand setClips a
  // fresh array (re-reconciling the audio engine) on edits that never touched
  // hide state. Identity passthrough when nothing is hidden. The timeline
  // still shows the clip bar (it reads the unfiltered composition) — hiding
  // mutes, it doesn't remove the row.
  const hiddenAudioSignature = useMemo(
    () => hiddenIdSignature(mergedComposition?.overlays),
    [mergedComposition?.overlays],
  );
  const playbackAudioClips = useMemo(
    () =>
      stripHiddenAudioClips(
        composition?.audioClips ?? EMPTY_AUDIO_CLIPS,
        hiddenIdSetFromSignature(hiddenAudioSignature),
      ),
    [composition?.audioClips, hiddenAudioSignature],
  );
  useEffect(() => {
    audioEngineRef.current?.setClips(playbackAudioClips);
  }, [playbackAudioClips, audioEngineRef]);
  useEffect(() => {
    audioEngineRef.current?.setMasterVolume(masterOutputVolume);
  }, [masterOutputVolume, audioEngineRef]);

  // Dev-only playback probe for the warming-eval harness. OFF unless
  // localStorage["libi:preview-probe"] === "1". Reads the frame imperatively
  // via getFrame() so the probe never forces a re-render.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem("libi:preview-probe") !== "1") return;
    (window as unknown as { __libiPreviewProbe?: unknown }).__libiPreviewProbe = {
      seek: transport.seek,
      play: transport.play,
      pause: transport.pause,
      get frame() {
        return transport.getFrame();
      },
      get phase() {
        return transport.phase;
      },
    };
  });

  // Seek helper (seconds) shared by the panel "Jump" + timeline marker clicks.
  const seekToSeconds = useCallback(
    (sec: number) => transport.seek(Math.round(sec * (composition?.fps ?? 30))),
    [transport.seek, composition?.fps],
  );

  // Opening (or switching to) a different piece starts its preview at the
  // beginning. This component stays mounted across piece switches, so the
  // transport would otherwise keep the PREVIOUS piece's playhead — meaning a
  // freshly created multi-scene piece could open parked on its last scene
  // instead of at 0. A targeted auto-show seek (pendingSeek) still wins because
  // it fires later, once the new composition has loaded.
  const seekedPieceRef = useRef<string | null>(null);
  useEffect(() => {
    if (seekedPieceRef.current === pieceId) return;
    seekedPieceRef.current = pieceId;
    transport.seek(0);
    selectionStore.set(null);
    keyframeSelectionStore.set(null);
  }, [pieceId, transport.seek, selectionStore, keyframeSelectionStore]);


  // Timeline marker ticks (driven by PreviewPlayer's selected tracked anchors).
  const [timelineMarkers, setTimelineMarkers] = useState<{ time: number; id: string }[]>([]);

  // Context-menu + duck-dialog state (triggered from the Timeline).
  const [contextMenu, setContextMenu] = useState<{ clipId: string; x: number; y: number } | null>(null);
  const [overlayContextMenu, setOverlayContextMenu] = useState<{ overlayId: string; x: number; y: number } | null>(null);
  // Keyframe-diamond right-click menu — separate from the clip menu so the
  // destructive delete-keyframe can never be confused with removing the overlay.
  const [keyframeContextMenu, setKeyframeContextMenu] = useState<{ overlayId: string; t: number; x: number; y: number } | null>(null);
  // Unified timeline clip ops (cut / delete / duplicate) — shares the
  // lib/composition/clip-ops core with the libi.*_clip MCP tools via /clips.
  const clipOps = useClipOps(pieceId, selectionStore);
  const [duckDialogClipId, setDuckDialogClipId] = useState<string | null>(null);
  const updateClip = useUpdateAudioClip(pieceId);

  // Stable Timeline props — recomputed only when their real inputs change, so
  // this component's 30 Hz re-render does not re-allocate them each frame.
  const timelineAudioClips = composition?.audioClips ?? EMPTY_AUDIO_CLIPS;
  const handleToggleClipEnabled = useCallback(
    (clipId: string) => {
      const clip = composition?.audioClips?.find((c) => c.id === clipId);
      if (!clip) return;
      updateClip.mutate({ clipId, patch: { enabled: !clip.enabled } });
    },
    [composition?.audioClips, updateClip],
  );
  const handleClipContextMenu = useCallback(
    (clipId: string, x: number, y: number) => setContextMenu({ clipId, x, y }),
    [],
  );
  // Detach a video overlay's coupled inline audio → standalone (its own track).
  // Mirrors the context-menu "unlink"; the server emits refresh_query so the
  // composition refetch moves the clip into the standalone Audio section.
  const handleDetachAudio = useCallback(
    (clipId: string) => {
      void fetch(`/api/pieces/${pieceId}/audio-clips/${clipId}/unlink`, { method: "POST" });
    },
    [pieceId],
  );
  // Re-attach a detached clip to its video overlay (→ coupled again).
  const handleRelinkAudio = useCallback(
    (clipId: string, overlayId: string) => {
      void fetch(`/api/pieces/${pieceId}/audio-clips/${clipId}/relink-overlay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overlayId }),
      });
    },
    [pieceId],
  );
  // Commit a standalone/detached clip's own timing (independent drag). Optimistic
  // via useUpdateAudioClip so the strip holds its dragged position with no flash.
  const handleCommitClipTiming = useCallback(
    (clipId: string, timing: { startTime: number; duration: number }) => {
      updateClip.mutate({ clipId, patch: timing });
    },
    [updateClip],
  );
  // Commit a DETACHED audio track's timing AND/OR vertical placement
  // (`timelineOrder`) in ONE optimistic patch. A detached drag is horizontal
  // (time) + vertical (reorder this track only). A single PATCH avoids a
  // two-PATCH lost-update race on the server (each call loads+saves the manifest
  // independently, so a second save would clobber the first). Only the audio
  // moves — never the video.
  const handleCommitDetachedTrack = useCallback(
    (clipId: string, patch: { startTime: number; duration: number; timelineOrder?: number }) => {
      updateClip.mutate({ clipId, patch });
    },
    [updateClip],
  );
  const handleOverlayContextMenu = useCallback(
    (overlayId: string, x: number, y: number) => setOverlayContextMenu({ overlayId, x, y }),
    [],
  );
  const handleKeyframeContextMenu = useCallback(
    (overlayId: string, t: number, x: number, y: number) =>
      setKeyframeContextMenu({ overlayId, t, x, y }),
    [],
  );
  // Inspector "Add keyframe at playhead" (Keyframes tab) — reads the live
  // playhead imperatively (no frame subscription), adds a keyframe on the
  // overlay + selects it. An out-of-window playhead is rejected by the route
  // (which toasts), so no reactive gating is needed here.
  const handleAddKeyframeAtPlayhead = useCallback(
    (overlayId: string) => {
      const ov = composition?.overlays?.find((o) => o.id === overlayId);
      if (!ov) return;
      const fps = composition?.fps ?? 30;
      const timeInClip = transport.getFrame() / fps - ov.startTime;
      keyframeOps.add.mutate(
        { overlayId, time: timeInClip },
        {
          onSuccess: () =>
            handleSelectKeyframe(overlayId, ov.duration > 0 ? timeInClip / ov.duration : 0),
        },
      );
    },
    [composition, transport, keyframeOps.add, handleSelectKeyframe],
  );

  // Per-row collapse state for the timeline's overlay lane rows. Kept in
  // PreviewSurface so it survives Timeline re-renders (and a future persist).
  const [collapsedRowGroups, setCollapsedRowGroups] = useState<Record<string, boolean>>({});
  const handleToggleRowCollapsed = useCallback((group: string) => {
    setCollapsedRowGroups((prev) => ({ ...prev, [group]: !prev[group] }));
  }, []);

  // Cross-row drag → rewrite z ATOMICALLY. Stored z is authoritative for both
  // render and timeline order (top row = highest z = FRONT). `deltaRows` (from
  // the pointer's real Y against the variable-height rows — see
  // crossRowDeltaFromY) moves the overlay that many positions in the flattened
  // front→back order. We then dense-rewrite z for EVERY overlay in ONE request
  // (POST .../overlays/reorder → reorderOverlaysInManifest, a single manifest
  // save). The old path fired N concurrent per-overlay z PATCHes that raced on
  // the manifest (last-writer-wins), so the order "snapped back" on refetch.
  // Optimistically patch the composition cache first so the new order shows
  // instantly and holds until the refetch reconciles. A null result = no move.
  const handleCrossRowOverlay = useCallback(
    (id: string, deltaRows: number) => {
      const overlays = composition?.overlays ?? [];
      const { zById } = buildLayersViewModel(overlays, {
        selectedIds: new Set(),
        hidden: {},
        locked: {},
      });
      const result = reorderZByDrag(zById, id, deltaRows);
      if (!result) return;
      const cur = overlays.find((o) => o.id === id);
      trackEvent("overlay_edited", { kind: cur?.kind ?? "text", op: "reorder" });

      // Optimistic: rewrite each overlay's z in the cached composition so the
      // timeline reorders immediately (no snap-back window).
      const key = pieceKeys.composition(pieceId);
      queryClient.setQueryData(key, (prev: unknown) => {
        const cached = prev as
          | { manifest?: { overlays?: { id: string; z: number }[] } }
          | undefined;
        const list = cached?.manifest?.overlays;
        if (!cached || !list) return prev;
        const nextOverlays = list.map((o) =>
          o.id in result.zById ? { ...o, z: result.zById[o.id] } : o,
        );
        return { ...cached, manifest: { ...cached.manifest, overlays: nextOverlays } };
      });

      // One atomic save (no per-overlay race).
      void fetch(`/api/pieces/${pieceId}/overlays/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overlayIdsInZOrder: result.overlayIdsInZOrder }),
      });
    },
    [composition?.overlays, pieceId, queryClient],
  );

  const handleCommitOverlayTiming = useCallback(
    (id: string, timing: { startTime: number; duration: number }) => {
      const kind = composition?.overlays?.find((o) => o.id === id)?.kind ?? "text";
      trackEvent("overlay_edited", { kind, op: "timing" });
      void commitOverlayTransform(id, { startTime: timing.startTime, duration: timing.duration });
    },
    [composition?.overlays, commitOverlayTransform],
  );

  // ── Effect-preview-on-select: play the selected effect's window once ──────
  // On every effectPreviewStore request (nonce bump — fires even when the same
  // effect is re-clicked), seek the MAIN transport to the effect's window and
  // play it once. A short settle lets the new effect refetch/recompile so it
  // renders from the window's first frame. ALWAYS plays (interrupts current
  // playback) — the user explicitly asked a click to always (re)play.
  //
  // Everything the run needs is read imperatively via a ref, so this effect
  // subscribes ONCE and never tears down on composition/prop changes.
  const effectPreviewDepsRef = useRef({ transport, fps: composition?.fps ?? 30 });
  effectPreviewDepsRef.current = { transport, fps: composition?.fps ?? 30 };
  const effectPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const effectPreviewTeardownRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const run = () => {
      const req = effectPreviewStore.get();
      if (!req) return;
      const { transport: tx, fps } = effectPreviewDepsRef.current;
      const startFrame = Math.round(req.startSec * fps);
      const endFrame = Math.round(req.endSec * fps);
      effectPreviewTeardownRef.current?.();
      effectPreviewTeardownRef.current = playWindowOnce({ transport: tx, startFrame, endFrame });
    };
    const unsub = effectPreviewStore.subscribe(() => {
      if (effectPreviewTimerRef.current) clearTimeout(effectPreviewTimerRef.current);
      effectPreviewTimerRef.current = setTimeout(run, EFFECT_PREVIEW_SETTLE_MS);
    });
    return () => {
      unsub();
      if (effectPreviewTimerRef.current) clearTimeout(effectPreviewTimerRef.current);
      effectPreviewTeardownRef.current?.();
    };
    // effectPreviewStore is a stable ref; subscribe ONCE for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectPreviewStore]);

  return (
    <OverlayEditStoreProvider value={overlayEditStore}>
    <div className="flex h-full min-h-0 flex-col">
      <Group
        orientation="vertical"
        defaultLayout={{ top: previewTimelineSplit, timeline: 100 - previewTimelineSplit }}
        onLayoutChanged={handleTimelineLayoutChanged}
        className="min-h-0 flex-1"
      >
        <Panel id="top" minSize={35}>
          <Group
            groupRef={layersGroupRef}
            orientation="horizontal"
            defaultLayout={
              layersDocked
                ? { main: previewLayersSplit, layers: 100 - previewLayersSplit }
                : { main: 100, layers: 0 }
            }
            onLayoutChanged={handleLayersLayoutChanged}
            className="h-full"
          >
            <Panel id="main" minSize={30}>
              <div className="h-full">
                <PreviewPlayer
                  composition={mergedComposition}
                  editStore={overlayEditStore}
                  frameStore={transport.frameStore}
                  playing={transport.playing}
                  buffering={transport.buffering}
                  onPlayToggle={transport.toggle}
                  speed={transport.speed}
                  onSpeedChange={transport.setSpeed}
                  videoSources={videoSources}
                  videoErrors={videoErrors}
                  images={overlayImages}
                  compiledDrawFns={overlayCompiledFns}
                  codeContentBoxes={overlayCodeContentBoxes}
                  threeScenes={overlayThreeScenes}
                  spatialQuads={overlaySpatialQuads}
                  overlayErrors={overlayErrors}
                  fontsVersion={fontsVersion}
                  exportFlow={exportFlow}
                  pieceName={pieceName}
                  hasSnapshot={hasSnapshot}
                  hasDraft={hasDraft}
                  onEditOverlay={onEditOverlay}
                  editingOverlay={editingOverlay}
                  onOverlayCommit={onOverlayCommit}
                  onOverlayCancel={onOverlayCancel}
                  totalFrames={totalFrames}
                  masterVolume={transport.masterVolume}
                  masterMuted={transport.masterMuted}
                  onMasterVolumeChange={transport.setMasterVolume}
                  onToggleMasterMuted={transport.toggleMasterMuted}
                  pieceId={pieceId}
                  onSelectedAnchorsChange={setTimelineMarkers}
                  layersDocked={layersDocked}
                  onToggleLayers={toggleLayers}
                  selectionStore={selectionStore}
                  onOverlayTransformCommit={handleOverlayTransformCommit}
                  onOverlayTransformFlush={handleOverlayTransformFlush}
                  getOverlayLocked={(id) => getOverlayLocked(pieceId, id)}
                  effectsPanelOpen={effectsPanelOpen}
                  familyRequest={effectsFamilyRequest}
                  onToggleEffectsPanel={() => setEffectsPanelOpen(!effectsPanelOpen)}
                  onCloseEffectsPanel={() => setEffectsPanelOpen(false)}
                  onAddKeyframeAtPlayhead={handleAddKeyframeAtPlayhead}
                  effectHighlightStore={effectHighlightStore}
                  effectPreviewStore={effectPreviewStore}
                  keyframeSelectionStore={keyframeSelectionStore}
                  effectsReadOnly={viewMode === "snapshot"}
                  snapEnabled={snapEnabled}
                  onToggleSnap={() => setSnapEnabled(!snapEnabled)}
                />
              </div>
            </Panel>
            {layersDocked ? (
              <Separator className="group relative w-px bg-border transition-colors hover:bg-primary/60 data-[active]:bg-primary">
                <div className="absolute inset-y-0 -left-1 -right-1 z-10 group-hover:cursor-col-resize" />
              </Separator>
            ) : (
              <Separator className="w-0" />
            )}
            <Panel
              id="layers"
              minSize={layersDocked ? "240px" : 0}
              maxSize={layersDocked ? "360px" : undefined}
              collapsible
              collapsedSize={0}
            >
              {layersDocked && (
                <LayersInspectorPanel
                  composition={mergedComposition}
                  selectionStore={selectionStore}
                  highlightStore={highlightStore}
                  isOverlayLocked={(id) => getOverlayLocked(pieceId, id)}
                  onToggleLocked={(id) => setOverlayLocked(pieceId, id, !getOverlayLocked(pieceId, id))}
                  onCommit={handleOverlayTransformCommit}
                  onFlush={handleOverlayTransformFlush}
                  onSeekSeconds={seekToSeconds}
                  frameStore={transport.frameStore}
                  files={files}
                  previewQuality={previewQuality}
                  pieceId={pieceId}
                  resolveCtx={resolveCtx}
                  onCreateDirect={onCreateDirect}
                  onPickAsset={onPickAsset}
                  onAskAgent={onAskAgent}
                  onAskAgentModify={onAskAgentModify}
                  onTranscribeAudio={onTranscribeAudio}
                  effectHighlightStore={effectHighlightStore}
                  onOpenEffects={onOpenEffects}
                  effectsReadOnly={viewMode === "snapshot"}
                />
              )}
            </Panel>
          </Group>
        </Panel>
        <Separator className="group relative h-px bg-border transition-colors hover:bg-primary/60 data-[active]:bg-primary">
          <div className="absolute inset-x-0 -top-1 -bottom-1 z-10 group-hover:cursor-row-resize" />
        </Separator>
        <Panel id="timeline" minSize={10}>
          <div className="h-full overflow-y-auto">
            <Timeline
              totalFrames={totalFrames}
              frameStore={transport.frameStore}
              fps={composition?.fps ?? 30}
              onFrameChange={transport.seek}
              composition={mergedComposition}
              audioClips={timelineAudioClips}
              onToggleClipEnabled={handleToggleClipEnabled}
              onClipContextMenu={handleClipContextMenu}
              onOverlayContextMenu={handleOverlayContextMenu}
              markers={timelineMarkers}
              onMarkerClick={seekToSeconds}
              overlays={mergedComposition?.overlays}
              labelById={overlayLabelById}
              railTooltipById={railTooltipById}
              selectionStore={selectionStore}
              isOverlayLocked={(id) => getOverlayLocked(pieceId, id)}
              collapsedGroups={collapsedRowGroups}
              onToggleRowCollapsed={handleToggleRowCollapsed}
              onCommitOverlayTiming={handleCommitOverlayTiming}
              onCrossRowOverlay={handleCrossRowOverlay}
              pieceId={pieceId}
              resolveCtx={resolveCtx}
              onCreateDirect={onCreateDirect}
              onPickAsset={onPickAsset}
              onAskAgent={onAskAgent}
              durationSec={durationSec}
              frameSize={frameSize}
              onDropCreate={overlaysReadOnly ? undefined : onDropCreate}
              onDropFiles={overlaysReadOnly ? undefined : onDropFiles}
              onDropAudio={overlaysReadOnly ? undefined : onDropAudio}
              justAddedId={justAddedId}
              onDetachAudio={handleDetachAudio}
              onRelinkAudio={handleRelinkAudio}
              onCommitClipTiming={handleCommitClipTiming}
              onCommitDetachedTrack={handleCommitDetachedTrack}
              selectedKeyframe={selectedKeyframe}
              onSelectKeyframe={handleSelectKeyframe}
              onKeyframeContextMenu={handleKeyframeContextMenu}
            />
          </div>
        </Panel>
      </Group>


      {contextMenu && composition?.audioClips && (() => {
        const clip = composition.audioClips.find((c) => c.id === contextMenu.clipId);
        if (!clip) return null;
        const playheadTime = transport.getFrame() / (composition.fps || 30);
        return (
          <AudioClipContextMenu
            clip={clip}
            playheadTime={playheadTime}
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
            onToggleEnabled={() => {
              void fetch(`/api/pieces/${pieceId}/audio-clips/${clip.id}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ enabled: !clip.enabled }),
              });
            }}
            onSplit={() => {
              void fetch(`/api/pieces/${pieceId}/audio-clips/${clip.id}/split`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ time: playheadTime }),
              });
            }}
            onDuplicate={() => clipOps.duplicate.mutate({ targetId: clip.id })}
            onUnlink={() => {
              void fetch(`/api/pieces/${pieceId}/audio-clips/${clip.id}/unlink`, {
                method: "POST",
              });
            }}
            onRemove={() => {
              void fetch(`/api/pieces/${pieceId}/audio-clips/${clip.id}`, { method: "DELETE" });
            }}
            onDuckOpen={() => setDuckDialogClipId(clip.id)}
            onDuckDisable={() => {
              void fetch(`/api/pieces/${pieceId}/audio-clips/${clip.id}/duck`, { method: "DELETE" });
            }}
          />
        );
      })()}

      {overlayContextMenu && composition?.overlays && (() => {
        const ov = composition.overlays.find((o) => o.id === overlayContextMenu.overlayId);
        if (!ov) return null;
        const fps = composition.fps || 30;
        const playheadTime = transport.getFrame() / fps;
        // Time within the clip (0..duration) — what the keyframes route expects.
        const timeInClip = playheadTime - ov.startTime;
        const playheadInWindow = timeInClip >= 0 && timeInClip <= ov.duration;
        // Keyframe DELETE/CLEAR live on the diamond's own menu now (see
        // KeyframeContextMenu below) — the clip menu only ADDS a keyframe.
        const kfTs = overlayKeyframeTimes(ov);
        return (
          <OverlayClipContextMenu
            overlayId={ov.id}
            overlayKind={ov.kind}
            startTime={ov.startTime}
            duration={ov.duration}
            playheadTime={playheadTime}
            x={overlayContextMenu.x}
            y={overlayContextMenu.y}
            onClose={() => setOverlayContextMenu(null)}
            onCut={() => clipOps.split.mutate({ targetId: ov.id, atTime: playheadTime })}
            onDuplicate={() => clipOps.duplicate.mutate({ targetId: ov.id })}
            onRemove={() => clipOps.remove.mutate({ targetId: ov.id })}
            onRippleRemove={() => clipOps.remove.mutate({ targetId: ov.id, ripple: true })}
            playheadInWindow={playheadInWindow}
            hasKeyframes={kfTs.length > 0}
            onAddKeyframe={() =>
              keyframeOps.add.mutate(
                { overlayId: ov.id, time: timeInClip },
                {
                  onSuccess: () =>
                    handleSelectKeyframe(
                      ov.id,
                      ov.duration > 0 ? timeInClip / ov.duration : 0,
                    ),
                },
              )
            }
          />
        );
      })()}

      {keyframeContextMenu && composition?.overlays && (() => {
        const ov = composition.overlays.find((o) => o.id === keyframeContextMenu.overlayId);
        if (!ov) return null;
        const fps = composition.fps || 30;
        const t = keyframeContextMenu.t;
        const frame = Math.round(t * ov.duration * fps);
        const kfCount = overlayKeyframeTimes(ov).length;
        return (
          <KeyframeContextMenu
            label={`Keyframe @ ${frameToTimecode(frame, fps)}`}
            keyframeCount={kfCount}
            x={keyframeContextMenu.x}
            y={keyframeContextMenu.y}
            onClose={() => setKeyframeContextMenu(null)}
            onEditEasing={() => handleSelectKeyframe(ov.id, t)}
            onDelete={() =>
              keyframeOps.remove.mutate({ overlayId: ov.id, time: t * ov.duration })
            }
            onClearAll={() => keyframeOps.clear.mutate({ overlayId: ov.id })}
          />
        );
      })()}

      <OverlayAssetPicker
        pieceId={pieceId}
        kind={assetKind ?? "image"}
        open={assetKind !== null}
        onOpenChange={(o) => {
          if (!o) setAssetKind(null);
        }}
        onPick={(fileId) => {
          track("picker", assetKind!);
          addOverlay.mutate(defaultOverlayInit(assetKind!, { ...resolveCtx(), fileId }));
          setAssetKind(null);
        }}
      />

      {duckDialogClipId && composition?.audioClips && (() => {
        const clip = composition.audioClips.find((c) => c.id === duckDialogClipId);
        if (!clip) return null;
        const candidates = composition.audioClips.filter((c) => c.id !== clip.id);
        return (
          <DuckConfigDialog
            clip={clip}
            candidates={candidates}
            onCancel={() => setDuckDialogClipId(null)}
            onApply={async (params) => {
              await fetch(`/api/pieces/${pieceId}/audio-clips/${clip.id}/duck`, {
                method: clip.duck ? "PATCH" : "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(params),
              });
              setDuckDialogClipId(null);
            }}
          />
        );
      })()}

      <OverlayAgentDialog
        open={agentPrompt !== null}
        initialPrompt={agentPrompt ?? ""}
        onOpenChange={(o) => {
          if (!o) setAgentPrompt(null);
        }}
        sessionList={sessionList}
        chatVisible={chatVisible}
        toggleChat={toggleChat}
      />

      {pendingAudioDrop && (
        <AudioLengthDialog
          open
          assetName={pendingAudioDrop.assetName}
          assetDurationSec={pendingAudioDrop.assetDurationSec}
          pieceDurationSec={durationSec}
          startTimeSec={pendingAudioDrop.startTime}
          onCancel={() => setPendingAudioDrop(null)}
          onChoose={(duration) => {
            addAudioClip.mutate({
              fileId: pendingAudioDrop.fileId,
              startTime: pendingAudioDrop.startTime,
              duration,
            });
            setPendingAudioDrop(null);
          }}
        />
      )}
    </div>
    </OverlayEditStoreProvider>
  );
}
