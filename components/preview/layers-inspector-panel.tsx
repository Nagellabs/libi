"use client";

import { useMemo, useState } from "react";
import type { Composition, Overlay, TextOverlay, TrackedOverlay } from "@/lib/engine/types";
import type { FileRecord } from "@/lib/db/schema/types";
import type { PreviewQuality } from "@/lib/preview/tuning";
import { Eye, EyeOff, Lock, Unlock, Bot, Plus, FileText, Bookmark, Unlink, Link2 } from "lucide-react";
import { classifySelection } from "@/lib/preview/selection-classify";
import {
  baseSceneDetails,
  assetSourceDetails,
  audioClipDetails,
  type AssetSourceDetails,
  type AudioClipDetails,
  type SceneVideoDetails,
} from "@/lib/preview/scene-details";
import { getSceneAtFrame, getCompositionFrames } from "@/lib/engine/renderer";
import type { SelectionStore } from "@/lib/preview/selection-store";
import type { FrameStore } from "@/lib/preview/frame-store";
import { useSelectedOverlay, useSelectedOverlayIds } from "@/hooks/preview/use-selected-overlay";
import { BatchStyleBar } from "@/components/preview/batch-style-bar";
import { usePlaybackFrame } from "@/hooks/preview/use-playback-frame";
import { overlayKeyframeTimes } from "@/lib/overlays/keyframes";
import { overlayAtPlayhead } from "@/lib/overlays/display-overlay";
import { NumberSlider } from "@/components/preview/number-slider";
import { AnchorPad } from "@/components/preview/anchor-pad";
import { regionCenterPoint, placeBoxAtAnchor } from "@/lib/captions/anchor";
import type { CaptionAnchor } from "@/lib/captions/types";
import { defaultAnchorForKind } from "@/lib/overlays/anchor-default";
import { transformToUi, uiToTransform } from "@/components/preview/transform-fields";
import { CaptionInspector } from "@/components/preview/caption-inspector";
import { useCaptionStyles } from "@/lib/queries/caption-styles";
import { ThreeInspector } from "@/components/preview/three-inspector";
import { TransformFields } from "@/components/preview/transform-fields";
import { SizeField } from "@/components/preview/size-field";
import { ThreeDFields } from "@/components/preview/three-d-fields";

import { SceneDetailsBody } from "@/components/preview/scene-details-body";
import type { OverlayTransformPatch } from "@/hooks/editor/use-overlay-transform-commit";
import { useEditorState } from "@/lib/editor-state-context";
import type { EffectsFamily } from "@/components/preview/effects-panel";
import { AddOverlayMenu } from "@/components/preview/add-overlay-menu";
import { GroupModeSwitcher } from "@/components/preview/group-mode-switcher";
import { GroupField, HighlightProvider } from "@/components/preview/group-field";
import { InGroupAdvanced } from "@/components/preview/in-group-advanced";
import {
  advancedFieldKeysForKindGroup,
  defaultGroupForKind,
  type InspectorGroup,
} from "@/lib/overlays/inspector-fields";
import type { NewOverlayPayload, NewOverlayCtx } from "@/lib/overlays/new-overlay-defaults";
import type { HighlightStore } from "@/lib/preview/highlight-store";
import { useHighlightValue } from "@/hooks/preview/use-highlight";
import { EffectsInspector } from "@/components/preview/effects-inspector";
import type { EffectHighlightStore } from "@/lib/preview/effect-highlight-store";
import type { LayerKind } from "@/lib/effects/types";
import { OverlayPresetDialog } from "@/components/preview/overlay-preset-dialog";
import { TrackedAnchorsTab } from "@/components/preview/tracked-anchors-tab";

interface LayersInspectorPanelProps {
  composition: Composition | null;
  selectionStore: SelectionStore;
  /** Guided-edit highlight store — flashes the matching inspector field. */
  highlightStore: HighlightStore;
  /** Playhead store — used only for the no-selection fallback. */
  frameStore: FrameStore;
  files: FileRecord[] | undefined;
  previewQuality: PreviewQuality;
  isOverlayLocked: (id: string) => boolean;
  onToggleLocked: (id: string) => void;
  onCommit: (id: string, patch: OverlayTransformPatch) => void;
  /**
   * Force the pending edit for an overlay to persist NOW (flush the
   * debounced PATCH owned by PreviewSurface's `useOverlayTransformCommit`).
   * Discrete inspector edits (color pick, select, checkbox, number blur)
   * flush promptly; slider drags flush on release. The shared edit store
   * already painted instantly via `onCommit`. Optional so unit tests that
   * mount the panel without a flush handler still type-check.
   */
  onFlush?: (id: string) => void;
  /** Seek the preview playhead (seconds) — used by the tracked Anchors tab's
   *  "Jump" action. Optional so unit tests can mount without a transport. */
  onSeekSeconds?: (t: number) => void;
  /** Add-overlay picker wiring (owned by PreviewSurface's create host). */
  pieceId: string;
  resolveCtx: () => Omit<NewOverlayCtx, "fileId" | "group">;
  onCreateDirect: (payload: NewOverlayPayload) => void;
  onPickAsset: (kind: "image" | "video") => void;
  onAskAgent: (kind: "code" | "three" | "tracked") => void;
  onAskAgentModify?: (overlay: { id: string; kind: string; content?: string }) => void;
  /** Open the ask-agent composer seeded with a transcription prompt. */
  onTranscribeAudio?: (audio: { fileId: string; fileName: string; label?: string }) => void;
  /** Effects guided-edit highlight store (flashes the matching slot). */
  effectHighlightStore: EffectHighlightStore;
  /** Open the effects picker panel (above the play controls). */
  onOpenEffects: (family?: EffectsFamily) => void;
  /** Snapshot view → effects controls are read-only. */
  effectsReadOnly: boolean;
}

export default function LayersInspectorPanel({
  composition,
  selectionStore,
  highlightStore,
  frameStore,
  files,
  previewQuality,
  isOverlayLocked,
  onToggleLocked,
  onCommit,
  onFlush,
  onSeekSeconds,
  pieceId,
  resolveCtx,
  onCreateDirect,
  onPickAsset,
  onAskAgent,
  onAskAgentModify,
  onTranscribeAudio,
  effectHighlightStore,
  onOpenEffects,
  effectsReadOnly,
}: LayersInspectorPanelProps) {
  const {
    viewMode,
    getOverlayInspectorMode,
    setOverlayInspectorMode,
    getOverlaySizeSplit,
    setOverlaySizeSplit,
  } = useEditorState();
  const selectedId = useSelectedOverlay(selectionStore);
  const selectedIds = useSelectedOverlayIds(selectionStore);
  const isMulti = selectedIds.length > 1;
  const [presetOpen, setPresetOpen] = useState(false);
  const highlight = useHighlightValue(highlightStore);
  const selection = classifySelection(selectedId, composition);
  const selectedOverlay: Overlay | null = selection?.kind === "overlay" ? selection.overlay : null;
  const isAudio = selection?.kind === "audioClip";
  // The live playhead frame is ONLY needed to describe the scene-under-playhead
  // when nothing (or a scene) is selected. While an overlay/audio clip is
  // selected we don't read it — so subscribe only then, otherwise this whole
  // 800-line inspector would re-render 30 Hz during playback (the measured
  // post-edit GC stutter, since editing leaves the overlay selected).
  // Phase 9: subscribe to the frame ALSO when a keyframed overlay is selected,
  // so the number fields (rect / opacity / transform3d) show the value RESOLVED
  // AT THE PLAYHEAD instead of the static base. A NON-keyframed selection keeps
  // `enabled=false` → identical frame-isolation, identical displayed values.
  const overlayIsKeyframed =
    !!selectedOverlay && overlayKeyframeTimes(selectedOverlay).length > 0;
  const frame = usePlaybackFrame(
    frameStore,
    (!selectedOverlay && !isAudio) || overlayIsKeyframed,
  );
  // The overlay whose values the inspector DISPLAYS: resolved at the playhead
  // when keyframed, else the SAME reference (no new object). Edits still commit
  // via `overlay.id` (auto-keyframing writes at the playhead), so feeding the
  // resolved rect/opacity/transform3d only changes the shown value.
  const displayOverlay = composition
    ? overlayAtPlayhead(selectedOverlay, composition.fps > 0 ? frame / composition.fps : 0, composition.fps)
    : selectedOverlay;
  // Canvas dims + total composition duration — threaded into the caption
  // inspector so the anchor pad places relative to THIS canvas and the timing
  // sliders cap at the composition length. Uses getCompositionFrames (max
  // across scenes, overlays, and audio clips) rather than the scene-only
  // getTotalFrames, which is 0 for a zero-scene (fully-overlay) composition
  // and would collapse the caption timing sliders' max to 0.
  const canvasFrame = composition
    ? { width: composition.width, height: composition.height }
    : undefined;
  const videoDurationMs =
    composition && composition.fps > 0
      ? (getCompositionFrames(composition) / composition.fps) * 1000
      : undefined;
  // Per-overlay inspector tab (intent group); default = kind's default group.
  const overlayMode: InspectorGroup = selectedOverlay
    ? getOverlayInspectorMode(pieceId, selectedOverlay.id, selectedOverlay.kind)
    : "transform";

  // Source-file info for a selected image overlay (a short read-only section).
  const imageInfo: AssetSourceDetails | null =
    selectedOverlay?.kind === "image"
      ? assetSourceDetails((selectedOverlay as { fileId: string }).fileId, files)
      : null;

  // Details for a selected audio clip (clip + linked scene + source file).
  const audioDetails: AudioClipDetails | null = useMemo(
    () => (isAudio ? audioClipDetails(composition, selectedId!, files) : null),
    [isAudio, composition, selectedId, files],
  );

  // Scene to describe: the selected scene, else the scene under the playhead.
  // Skip the playhead fallback when an overlay OR an audio clip is selected.
  const sceneDetails = useMemo(() => {
    if (selection?.kind === "scene") {
      return baseSceneDetails(composition, selection.index, files, previewQuality);
    }
    if (!selectedOverlay && !isAudio && composition && composition.scenes.length > 0) {
      const { sceneIndex } = getSceneAtFrame(composition, frame);
      return baseSceneDetails(composition, sceneIndex, files, previewQuality);
    }
    return null;
  }, [selection, selectedOverlay, isAudio, composition, files, previewQuality, frame]);

  const headerLabel = isMulti
    ? `${selectedIds.length} layers selected`
    : selectedOverlay
    ? `${selectedOverlay.kind} layer`
    : audioDetails
      ? `Audio — ${audioDetails.clip.label ?? (audioDetails.clip.kind === "inline" ? "linked audio" : "clip")}`
      : sceneDetails?.scene
        ? `Scene — ${sceneDetails.scene.name}`
        : "Nothing selected";

  return (
    <div
      className="flex h-full min-w-0 flex-col overflow-y-auto overflow-x-hidden bg-surface text-foreground"
      data-testid="layers-inspector-panel"
    >
      {/* Header: selected layer + add-overlay; tab bar on its own full-width row. */}
      <div className="flex flex-col gap-1 border-b border-border p-2">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1 truncate text-[11px] font-semibold text-foreground" title={headerLabel}>
            {headerLabel}
          </div>
          {viewMode !== "snapshot" && !isMulti && selectedOverlay && (
            <button
              type="button"
              data-testid="inspector-open-presets"
              onClick={() => setPresetOpen(true)}
              className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              title="Save this layer as a reusable preset, or apply a saved one"
            >
              <Bookmark className="size-3" /> Preset
            </button>
          )}
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
        </div>
        {!isMulti && selectedOverlay && (
          <OverlayPresetDialog
            pieceId={pieceId}
            overlay={selectedOverlay}
            open={presetOpen}
            onOpenChange={setPresetOpen}
          />
        )}
        {!isMulti && selectedOverlay && (
          <GroupModeSwitcher
            kind={selectedOverlay.kind}
            mode={overlayMode}
            onChange={(m) =>
              setOverlayInspectorMode(pieceId, selectedOverlay.id, m)
            }
          />
        )}
      </div>

      {/* Inspector body. `@container` so child column containers can widen their
          vertical gap on narrow panels (where slider rows wrap under their
          labels and would otherwise crowd) — gap-3 narrow, gap-2 once wide. */}
      <div className="@container flex min-w-0 flex-col gap-3 p-2 @[300px]:gap-2">
        {isMulti ? (
          <BatchStyleBar
            pieceId={pieceId}
            composition={composition}
            selectedIds={selectedIds}
            readOnly={effectsReadOnly}
          />
        ) : selectedOverlay ? (
          <HighlightProvider
            value={
              highlight && highlight.overlayId === selectedOverlay.id
                ? { property: highlight.property, note: highlight.note }
                : null
            }
          >
            <OverlayInspectorBody
              overlay={displayOverlay ?? selectedOverlay}
              mode={overlayMode}
              onCommit={onCommit}
              onFlush={onFlush}
              onSeekSeconds={onSeekSeconds}
              onAskAgentModify={onAskAgentModify}
              isLocked={isOverlayLocked(selectedOverlay.id)}
              onToggleLocked={() => onToggleLocked(selectedOverlay.id)}
              pieceId={pieceId}
              frame={canvasFrame}
              videoDurationMs={videoDurationMs}
              getSizeSplit={(overlayId) => getOverlaySizeSplit(pieceId, overlayId)}
              setSizeSplit={(overlayId, split) => setOverlaySizeSplit(pieceId, overlayId, split)}
              effectHighlightStore={effectHighlightStore}
              onOpenEffects={onOpenEffects}
              effectsReadOnly={effectsReadOnly}
            />
            {imageInfo && <AssetInfoBlock title="Image info" file={imageInfo} />}
          </HighlightProvider>
        ) : audioDetails ? (
          <>
            <AudioDetailsBody details={audioDetails} pieceId={pieceId} onTranscribe={onTranscribeAudio} />
            <EffectsInspector
              pieceId={pieceId}
              layerId={audioDetails.clip.id}
              kind="audio"
              effects={audioDetails.clip.effects}
              effectHighlightStore={effectHighlightStore}
              onOpenPicker={onOpenEffects}
              readOnly={effectsReadOnly}
            />
          </>
        ) : sceneDetails?.scene && selection?.kind === "scene" ? (
          <>
            <SceneDetailsBody details={sceneDetails} composition={composition} />
            <EffectsInspector
              pieceId={pieceId}
              layerId={selection.scene.id}
              kind="scene"
              effects={selection.scene.effects}
              effectHighlightStore={effectHighlightStore}
              onOpenPicker={onOpenEffects}
              readOnly={effectsReadOnly}
            />
          </>
        ) : sceneDetails?.scene ? (
          <SceneDetailsBody details={sceneDetails} composition={composition} />
        ) : (
          <div className="text-[11px] text-muted-foreground">Select a layer to edit it.</div>
        )}
      </div>
    </div>
  );
}

export function OverlayInspectorBody({
  overlay,
  mode,
  onCommit,
  onFlush,
  onSeekSeconds,
  onAskAgentModify,
  isLocked,
  onToggleLocked,
  pieceId,
  frame,
  videoDurationMs,
  getSizeSplit,
  setSizeSplit,
  effectHighlightStore,
  onOpenEffects,
  effectsReadOnly,
}: {
  overlay: Overlay;
  mode: InspectorGroup;
  onCommit: (id: string, patch: OverlayTransformPatch) => void;
  onFlush?: (id: string) => void;
  /** Seek the preview playhead (seconds) — used by the tracked Anchors tab's
   *  "Jump" action. Optional so unit tests can mount without a transport. */
  onSeekSeconds?: (t: number) => void;
  onAskAgentModify?: (overlay: { id: string; kind: string; content?: string }) => void;
  isLocked?: boolean;
  onToggleLocked?: () => void;
  pieceId: string;
  /** Canvas dims — drives the caption anchor pad's canvas-relative placement. */
  frame?: { width: number; height: number };
  /** Total video (scene) duration in ms — caps caption timing sliders. */
  videoDurationMs?: number;
  /** Per-overlay W/H split memory (from editor-state, threaded by the panel).
   *  Optional so unit tests can mount the body without an EditorStateProvider —
   *  they default to non-split. */
  getSizeSplit?: (overlayId: string) => boolean;
  setSizeSplit?: (overlayId: string, split: boolean) => void;
  effectHighlightStore: EffectHighlightStore;
  onOpenEffects: (family?: EffectsFamily) => void;
  effectsReadOnly: boolean;
}) {
  // Bundled + user caption styles for the Style-tab picker (text only). Cached
  // React Query; `undefined` while loading → CaptionInspector falls back to the
  // bundled const. Invalidated by the `caption-styles` refresh_query after the
  // agent creates/deletes a style.
  const { data: captionStyles } = useCaptionStyles();

  // For text, the CaptionInspector owns ALL three groups (transform / style /
  // text) including the placement panel — so the generic transform block is
  // NOT rendered here (it would double-mount the transform keys). For the other
  // kinds, the generic transform block below is the one transform group.
  const isText = overlay.kind === "text";
  // A DISCRETE edit (number-blur, button toggle, select) paints via the shared
  // store (onCommit) AND persists promptly (onFlush) — no need to wait for the
  // trailing debounce. The continuous slider case stays on commit-only and
  // flushes on release (wired per-slider via NumberSlider's onCommitEnd).
  const commitDiscrete = (id: string, patch: OverlayTransformPatch) => {
    onCommit(id, patch);
    onFlush?.(id);
  };
  // Per-overlay W/H split memory (defaults to non-split when no provider —
  // the coverage test mounts this body bare).
  const sizeSplit = getSizeSplit?.(overlay.id) ?? false;
  const toggleSizeSplit = (s: boolean) => setSizeSplit?.(overlay.id, s);
  // Upper bound for the Start/End sliders. Use the composition duration when
  // known; otherwise a generous 10-minute fallback so the slider stays usable.
  const timelineMaxMs = videoDurationMs ?? 600000;
  return (
    <>
      {/* Visible / Locked — the TOP row of the FIRST tab for EVERY overlay kind
          (Text for text; Transform for image/video/code/three/tracked), so the
          layer on/off + lock controls always sit in the same, consistent place.
          Visible commits the PERSISTED `hidden` field (a real draft edit — layer
          OFF everywhere incl. export); Locked stays editor-local. Disabled in
          read-only (snapshot) view so the eye can't create a draft there. */}
      {mode === defaultGroupForKind(overlay.kind) && (
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="inspector-hide"
            disabled={effectsReadOnly}
            onClick={() => commitDiscrete(overlay.id, { hidden: !overlay.hidden })}
            className={`flex flex-1 cursor-pointer items-center justify-center gap-1 rounded border px-2 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-50 ${
              overlay.hidden ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground"
            }`}
            title={overlay.hidden ? "Show layer (currently OFF everywhere)" : "Hide layer (OFF everywhere, incl. export)"}
          >
            {overlay.hidden ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
            {overlay.hidden ? "Hidden" : "Visible"}
          </button>
          <button
            type="button"
            data-testid="inspector-lock"
            onClick={onToggleLocked}
            className={`flex flex-1 cursor-pointer items-center justify-center gap-1 rounded border px-2 py-1 text-[11px] ${
              isLocked ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground"
            }`}
            title={isLocked ? "Unlock" : "Lock"}
          >
            {isLocked ? <Lock className="size-3" /> : <Unlock className="size-3" />}
            {isLocked ? "Locked" : "Unlocked"}
          </button>
        </div>
      )}
      {/* Unified 3D Transform panel — Position X/Y/Z, Angle/Elevation/Spin,
          Size, Reset. The non-three, non-text kinds use it as their (single)
          transform group. `three` keeps its dedicated gizmo inspector below;
          `text` delegates to CaptionInspector. */}
      {!isText && overlay.kind !== "three" && mode === "transform" && (
        <TransformFields
          overlay={overlay}
          frame={frame}
          sizeSplit={sizeSplit}
          onToggleSizeSplit={toggleSizeSplit}
          onPatch={(p) => onCommit(overlay.id, p)}
          onCommitEnd={() => onFlush?.(overlay.id)}
        />
      )}
      {/* 3D group — the "Make it 3D" gate + on-surface Angle/Elevation/Depth-Z.
          tracked has no 3D tab (its registry keeps the legacy single-group
          layout), so it never reaches here on a 3D mode. */}
      {!isText && overlay.kind !== "three" && overlay.kind !== "tracked" && mode === "3d" && (
        <ThreeDFields
          overlay={overlay}
          onPatch={(p) => onCommit(overlay.id, p)}
          onCommitEnd={() => onFlush?.(overlay.id)}
        />
      )}
      {/* `three` keeps its legacy rect/rotation controls (its registry still
          lists these keys — its dedicated gizmo lives in <ThreeInspector>
          below). Flip H/V now lives in the opacity/timing advanced block below
          (before Z-order), so this block has no advanced fields of its own and
          renders ThreeTransformPlanar directly. */}
      {overlay.kind === "three" && (
        <ThreeTransformPlanar
          overlay={overlay}
          mode={mode}
          frame={frame}
          commitDiscrete={commitDiscrete}
          sizeSplit={sizeSplit}
          onToggleSizeSplit={toggleSizeSplit}
        />
      )}
      {/* Opacity / Flip / Z-order / Timing — rendered for every NON-TEXT kind in
          the transform group, all via NumberSlider. Flip H/V (three only) + the
          Z-order + timing rows hide behind the in-group "Advanced ▾" reveal;
          Flip sits FIRST in that block, before Z-order. (text owns these via
          CaptionInspector.) */}
      {!isText && (
        <InGroupAdvanced
          hasAdvanced={["flipH", "flipV", "zOrder", "startTime", "endTime"].some((k) =>
            advancedFieldKeysForKindGroup(overlay.kind, mode).includes(k),
          )}
          common={
            <GroupField fieldKey="opacity" kind={overlay.kind} group={mode}>
              <NumberSlider
                label="Opacity"
                unit="%"
                value={Math.round((overlay.opacity ?? 1) * 100)}
                min={0}
                max={100}
                defaultValue={100}
                onChange={(v) => commitDiscrete(overlay.id, { opacity: Math.max(0, Math.min(1, v / 100)) })}
              />
            </GroupField>
          }
          advanced={
            <>
              <div className="flex gap-2 [&>*]:flex-1">
                <GroupField fieldKey="flipH" kind={overlay.kind} group={mode}>
                  <button
                    type="button"
                    data-testid="inspector-flipH"
                    onClick={() => commitDiscrete(overlay.id, { flipH: !overlay.flipH })}
                    className={`w-full cursor-pointer rounded border px-2 py-1 text-[11px] ${
                      overlay.flipH ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                    title="Flip horizontal — mirror the layer left ↔ right"
                  >
                    Flip H
                  </button>
                </GroupField>
                <GroupField fieldKey="flipV" kind={overlay.kind} group={mode}>
                  <button
                    type="button"
                    data-testid="inspector-flipV"
                    onClick={() => commitDiscrete(overlay.id, { flipV: !overlay.flipV })}
                    className={`w-full cursor-pointer rounded border px-2 py-1 text-[11px] ${
                      overlay.flipV ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                    title="Flip vertical — mirror the layer top ↔ bottom"
                  >
                    Flip V
                  </button>
                </GroupField>
              </div>
              <GroupField fieldKey="zOrder" kind={overlay.kind} group={mode}>
                <NumberSlider
                  label="Layer order"
                  value={Math.round(overlay.z)}
                  min={0}
                  max={100}
                  defaultValue={0}
                  onChange={(v) => commitDiscrete(overlay.id, { z: Math.round(v) })}
                />
              </GroupField>
              <GroupField fieldKey="startTime" kind={overlay.kind} group={mode}>
                <NumberSlider
                  label="Start"
                  unit="ms"
                  value={Math.round(overlay.startTime * 1000)}
                  min={0}
                  max={timelineMaxMs}
                  step={10}
                  onChange={(v) => commitDiscrete(overlay.id, { startTime: Math.max(0, v / 1000) })}
                />
              </GroupField>
              <GroupField fieldKey="endTime" kind={overlay.kind} group={mode}>
                <NumberSlider
                  label="End"
                  unit="ms"
                  value={Math.round((overlay.startTime + overlay.duration) * 1000)}
                  min={0}
                  max={timelineMaxMs}
                  step={10}
                  onChange={(v) => {
                    const end = Math.max(overlay.startTime * 1000 + 1, v) / 1000;
                    commitDiscrete(overlay.id, { duration: Math.max(1 / 30, end - overlay.startTime) });
                  }}
                />
              </GroupField>
            </>
          }
        />
      )}
      {overlay.kind === "text" && (
        <div className="mt-1 border-t border-border pt-2">
          <CaptionInspector
            overlay={overlay}
            mode={mode}
            pieceId={pieceId}
            frame={frame}
            videoDurationMs={videoDurationMs}
            captionStyles={captionStyles}
            onPatch={(p) => onCommit(overlay.id, p)}
            onFlush={() => onFlush?.(overlay.id)}
          />
        </div>
      )}
      {overlay.kind === "three" && (
        <div className="mt-1 border-t border-border pt-2">
          <ThreeInspector
            overlay={overlay}
            mode={mode}
            onPatch={(p) => onCommit(overlay.id, p)}
            onFlush={() => onFlush?.(overlay.id)}
          />
        </div>
      )}
      {overlay.kind === "tracked" && mode === "transform" && (
        <div className="flex flex-col gap-2">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Follow offset
          </h4>
          <GroupField fieldKey="offsetX" kind="tracked" group={mode}>
            <NumberSlider
              label="Offset X"
              unit="%"
              value={Math.round((overlay.offset?.x ?? 0) * 100)}
              min={-300}
              max={300}
              defaultValue={0}
              onChange={(v) =>
                commitDiscrete(overlay.id, {
                  offset: { x: v / 100, y: overlay.offset?.y ?? 0 },
                })
              }
            />
          </GroupField>
          <GroupField fieldKey="offsetY" kind="tracked" group={mode}>
            <NumberSlider
              label="Offset Y"
              unit="%"
              value={Math.round((overlay.offset?.y ?? 0) * 100)}
              min={-300}
              max={300}
              defaultValue={0}
              onChange={(v) =>
                commitDiscrete(overlay.id, {
                  offset: { x: overlay.offset?.x ?? 0, y: v / 100 },
                })
              }
            />
          </GroupField>
          <div className="rounded border border-border bg-background/40 p-1.5 text-[10px] text-muted-foreground">
            fit: {overlay.fit} · scale: {overlay.scale} · smoothing: {overlay.smoothing}
          </div>
        </div>
      )}
      {overlay.kind === "tracked" && (
        <TrackedAnchorsTab
          overlay={overlay as TrackedOverlay}
          pieceId={pieceId}
          mode={mode}
          onSeekSeconds={onSeekSeconds}
        />
      )}
      {/* Ask agent — shown once, on the transform tab only (not repeated per group). */}
      {mode === "transform" && (
        <div className="mt-1 flex gap-2">
          <button
            type="button"
            data-testid="inspector-ask-agent"
            onClick={() =>
              onAskAgentModify?.({
                id: overlay.id,
                kind: overlay.kind,
                content: (overlay as { content?: string }).content,
              })
            }
            className="flex flex-1 cursor-pointer items-center justify-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <Bot className="size-3" /> Ask agent
          </button>
        </div>
      )}
      {/* Effects sub-panel — tracked overlays have no effect slots; gated to
          the Transform tab so it doesn't repeat on Style/Text/3D. */}
      {overlay.kind !== "tracked" && mode === "transform" && (
        <EffectsInspector
          pieceId={pieceId}
          layerId={overlay.id}
          kind={overlay.kind as LayerKind}
          effects={overlay.effects}
          reveal={overlay.kind === "text" ? (overlay as TextOverlay).reveal : undefined}
          effectHighlightStore={effectHighlightStore}
          onOpenPicker={onOpenEffects}
          readOnly={effectsReadOnly}
        />
      )}
    </>
  );
}

/**
 * The planar (2D) Transform controls for a `three` overlay — AnchorPad +
 * Position X/Y + Size + Spin, mirroring the shared image/video/code panel
 * (`TransformFields`) but driving `three`'s own rect/anchor/position/rotation
 * model. Keeps the registry `data-field` keys (`position`, `size`, `rotation`)
 * so the inspector-fields coverage parity holds. Flip H/V stays in the parent's
 * Advanced slot.
 */
function ThreeTransformPlanar({
  overlay,
  mode,
  frame,
  commitDiscrete,
  sizeSplit,
  onToggleSizeSplit,
}: {
  overlay: Overlay;
  mode: InspectorGroup;
  frame?: { width: number; height: number };
  commitDiscrete: (id: string, patch: OverlayTransformPatch) => void;
  sizeSplit: boolean;
  onToggleSizeSplit: (s: boolean) => void;
}) {
  const dims = frame ?? { width: 1920, height: 1080 };
  const rect = overlay.rect;
  // `anchor` is shared across all overlay kinds (BaseOverlay). Read it back
  // optimistically so a re-anchor sticks; default by kind.
  const anchor: CaptionAnchor = overlay.anchor ?? defaultAnchorForKind(overlay.kind);

  // In-plane Spin reads/writes transform3d.rotation.z through the shared mapper
  // — the SAME field every other kind's Transform Spin drives.
  const identityT = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
  };
  const threeSpin = transformToUi(overlay.transform3d ?? identityT).spin;
  const setThreeSpin = (next: number) => {
    const base = overlay.transform3d ?? identityT;
    commitDiscrete(overlay.id, {
      transform3d: uiToTransform({ ...transformToUi(base), spin: next }),
    });
  };

  // Position X/Y = the CONTENT CENTER of the box. `three` is always frame-filling,
  // so referencing the center (not a corner) keeps the slider direction intuitive
  // — dragging X right moves the 3D content right, Y down moves it down. Editing
  // re-centres the box on the new point.
  const posCenter = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const setPosition = (next: { x?: number; y?: number }) => {
    const c = {
      x: Math.round(next.x ?? posCenter.x),
      y: Math.round(next.y ?? posCenter.y),
    };
    const r = placeBoxAtAnchor(c, "mid-center", rect.width, rect.height);
    commitDiscrete(overlay.id, {
      position: c,
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: r.width, height: r.height },
    });
  };

  // Anchor pad — move the box so its CONTENT CENTER sits at the named region
  // (`regionCenterPoint`): top→top, left→left. For a frame-filling `three` box
  // this lands the content at ¼/½/¾ of the frame instead of the corner-anchor
  // inversion (anchor "top-left" used to push the content DOWN-RIGHT). `anchor`
  // is stored for the pad highlight only.
  const placeAtCanvasAnchor = (a: CaptionAnchor) => {
    const c = regionCenterPoint(a, dims, { width: rect.width, height: rect.height });
    const r = placeBoxAtAnchor(c, "mid-center", rect.width, rect.height);
    commitDiscrete(overlay.id, {
      anchor: a,
      position: { x: Math.round(c.x), y: Math.round(c.y) },
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
    });
  };

  return (
    <>
      {/* Position (anchor-pinned X/Y) */}
      <GroupField fieldKey="position" kind={overlay.kind} group={mode}>
        <div className="flex flex-col gap-2.5 @[300px]:gap-1.5">
          <NumberSlider
            label="X"
            unit="px"
            value={Math.round(posCenter.x)}
            min={0}
            max={dims.width}
            defaultValue={Math.round(dims.width / 2)}
            onChange={(v) => setPosition({ x: v })}
          />
          <NumberSlider
            label="Y"
            unit="px"
            value={Math.round(posCenter.y)}
            min={0}
            max={dims.height}
            defaultValue={Math.round(dims.height / 2)}
            onChange={(v) => setPosition({ y: v })}
          />
          <AnchorPad anchor={anchor} onAnchorChange={placeAtCanvasAnchor} className="mx-auto" />
        </div>
      </GroupField>
      {/* Size = rect window W/H — the SAME generic control as image/video/code.
          Resizing the rect scales the apparent 3D content (the scene fills it). */}
      <GroupField fieldKey="size" kind={overlay.kind} group={mode}>
        <SizeField
          sizeMode="box"
          split={sizeSplit}
          onToggleSplit={onToggleSizeSplit}
          width={Math.round(rect.width)}
          height={Math.round(rect.height)}
          onCommitSize={(w, h) =>
            commitDiscrete(overlay.id, {
              rect: { ...rect, width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) },
            })
          }
          onCommitWidth={(w) =>
            commitDiscrete(overlay.id, { rect: { ...rect, width: Math.max(1, Math.round(w)) } })
          }
          onCommitHeight={(h) =>
            commitDiscrete(overlay.id, { rect: { ...rect, height: Math.max(1, Math.round(h)) } })
          }
        />
      </GroupField>
      {/* In-plane Spin — drives transform3d.rotation.z (the SAME underlying
          field as every other kind's Transform Spin), so the renderer's
          transform3d roll applies consistently. The legacy `overlay.rotation`
          path is no longer written here. The registry `data-field` stays
          `rotation` (three's in-plane spin key). */}
      <GroupField fieldKey="rotation" kind={overlay.kind} group={mode}>
        <NumberSlider
          label="Spin"
          unit="°"
          value={threeSpin}
          min={-180}
          max={180}
          defaultValue={0}
          onChange={setThreeSpin}
        />
      </GroupField>
    </>
  );
}

function fmtClock(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function fmtDims(w: number | null, h: number | null): string {
  if (w != null && h != null) return `${w}×${h}`;
  if (h != null) return `${h}p`;
  return "—";
}

/** A labelled key/value row in a read-only details list. */
function InfoRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt>{k}</dt>
      <dd className="truncate text-foreground/90" title={v}>
        {v}
      </dd>
    </div>
  );
}

/** Read-only source-file card: name, media kind, dimensions, duration. Shared
 *  by the image-info section and the audio source details. */
function AssetSourceCard({ file }: { file: AssetSourceDetails }) {
  return (
    <div className="rounded-md border border-border bg-background/60 p-2.5">
      <div className="truncate text-[11.5px] font-semibold text-foreground" title={file.fileName}>
        {file.fileName}
      </div>
      <dl className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground">
        <InfoRow k="Type" v={file.mediaKind} />
        {(file.sourceWidth != null || file.sourceHeight != null) && (
          <InfoRow k="Dimensions" v={fmtDims(file.sourceWidth, file.sourceHeight)} />
        )}
        {file.durationSec != null && <InfoRow k="Duration" v={fmtClock(file.durationSec)} />}
      </dl>
    </div>
  );
}

/** A small captioned info block (used for image overlays). */
function AssetInfoBlock({ title, file }: { title: string; file: AssetSourceDetails }) {
  return (
    <div className="mt-1 border-t border-border pt-2" data-testid="overlay-asset-info">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <AssetSourceCard file={file} />
    </div>
  );
}

/** Read-only details for a selected audio clip: what it is, the scene it
 *  follows (inline), its source-file card, playback params, and a button that
 *  opens the ask-agent composer seeded with a transcription prompt. */
function AudioDetailsBody({
  details,
  pieceId,
  onTranscribe,
}: {
  details: AudioClipDetails;
  pieceId: string;
  onTranscribe?: (audio: { fileId: string; fileName: string; label?: string }) => void;
}) {
  const { clip, linkedSceneName, linkedOverlayName, attached, relinkOverlayId, file } = details;
  const unlink = () =>
    void fetch(`/api/pieces/${pieceId}/audio-clips/${clip.id}/unlink`, { method: "POST" });
  const relink = () =>
    relinkOverlayId &&
    void fetch(`/api/pieces/${pieceId}/audio-clips/${clip.id}/relink-overlay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overlayId: relinkOverlayId }),
    });
  return (
    <div className="space-y-2" data-testid="audio-details-body">
      <div>
        <div
          className="truncate text-[12px] font-semibold text-foreground"
          title={clip.label ?? "Audio clip"}
        >
          {clip.label ?? (clip.kind === "inline" ? "Linked audio" : "Audio clip")}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {clip.kind === "inline" ? "Inline audio" : "Standalone audio"} ·{" "}
          {fmtClock(clip.startTime)}–{fmtClock(clip.startTime + clip.duration)}
        </div>
      </div>

      {/* Attach status + link/unlink. An attached clip moves with its video as
          one combined track; detaching makes it an independent track. */}
      <div
        className="space-y-1.5 rounded border border-border p-2"
        data-testid="audio-attach-box"
      >
        {attached ? (
          <>
            <div className="text-[11px] text-muted-foreground" data-testid="audio-attach-status">
              {linkedOverlayName ? (
                <>
                  Attached to video{" "}
                  <span className="text-foreground/90">{linkedOverlayName}</span> — moves with it.
                </>
              ) : linkedSceneName ? (
                <>
                  Follows scene <span className="text-foreground/90">{linkedSceneName}</span>.
                </>
              ) : (
                "Attached — moves with its video."
              )}
            </div>
            <button
              type="button"
              data-testid="audio-detach"
              onClick={unlink}
              className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
              title="Detach this audio from its video into its own independent track"
            >
              <Unlink className="size-3" /> Detach into its own track
            </button>
          </>
        ) : (
          <>
            <div className="text-[11px] text-muted-foreground" data-testid="audio-attach-status">
              {linkedOverlayName ? (
                <>
                  Detached from video{" "}
                  <span className="text-foreground/90">{linkedOverlayName}</span> — independent
                  track (still next to it).
                </>
              ) : (
                "Not attached — independent track."
              )}
            </div>
            {relinkOverlayId && (
              <button
                type="button"
                data-testid="audio-relink"
                onClick={relink}
                className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                title="Re-attach this audio to its video (move together as one track)"
              >
                <Link2 className="size-3" /> {linkedOverlayName ? "Re-attach to its video" : "Attach to its video"}
              </button>
            )}
          </>
        )}
      </div>

      {file && <AssetSourceCard file={file} />}
      <dl className="space-y-0.5 text-[11px] text-muted-foreground">
        <InfoRow k="Volume" v={`${Math.round(clip.volume * 100)}%`} />
        <InfoRow k="Trim start" v={`${clip.trimStart.toFixed(2)}s`} />
        <InfoRow k="Audible" v={clip.enabled ? "yes" : "muted"} />
      </dl>
      {file && onTranscribe && (
        <button
          type="button"
          data-testid="audio-transcribe"
          onClick={() =>
            onTranscribe({ fileId: file.fileId, fileName: file.fileName, label: clip.label })
          }
          className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
          title="Open the ask-agent composer with a transcription prompt"
        >
          <FileText className="size-3" /> Transcribe with agent
        </button>
      )}
    </div>
  );
}

export type { SceneVideoDetails };
