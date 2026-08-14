"use client";

import { useCallback, useRef, useState } from "react";
import type { LaneView } from "@/lib/preview/lane-bar-geometry";
import type { LayerRowVM } from "@/lib/overlays/layers-view-model";
import {
  OverlayBar,
  ROW_PIXEL_HEIGHT,
  type OverlayBarModel,
} from "@/components/preview/overlay-bar";
import { LIBI_FILE_MIME, decodeFileDrag } from "@/lib/preview/drag-payload";
import { seekFrameFromClick } from "@/lib/preview/timeline-seek";
import { resolveDrop } from "@/lib/preview/timeline-drop";
import type { MediaPaint } from "@/lib/preview/timeline-media";
import type { SelectionModifiers } from "@/lib/preview/selection-logic";

interface TimelineOverlayRowProps {
  row: LayerRowVM;
  timingById: Record<string, { startTime: number; duration: number }>;
  view: LaneView;
  collapsed: boolean;
  onSelect: (id: string, mods?: SelectionModifiers) => void;
  onCommitTiming: (id: string, timing: { startTime: number; duration: number }) => void;
  onCrossRow: (id: string, deltaRows: number) => void;
  /** Resolve a cross-row drag's delta from the pointer Y against the real
   *  (variable-height) rows. Threaded to each OverlayBar. */
  rowDeltaFromPointer?: (id: string, clientY: number) => number;
  /** Drop-indicator hover/end (threaded to each OverlayBar). */
  onDragHover?: (id: string, clientY: number) => void;
  onDragEnd?: () => void;
  /** Coupled video↔audio drag (threaded to each OverlayBar). */
  onCoupledDragMove?: (ownerOverlayId: string, deltaSec: number, dy: number) => void;
  onCoupledDragEnd?: () => void;
  coupledDrag?: { ownerOverlayId: string; deltaSec: number; dy: number } | null;
  /** Composition duration in seconds (used to map drop-x → start time). */
  durationSec?: number;
  /** This lane's group + z (used to seed the created overlay's lane/z). */
  rowGroup?: string;
  rowZ?: number;
  /** Composition frame size (used to seed the created overlay's rect). */
  frameSize?: { width: number; height: number };
  /** Create an overlay from an in-app asset dropped on this lane. */
  onDropCreate?: (args: {
    kind: "image" | "video";
    fileId: string;
    startTime: number;
    z: number;
    group?: string;
  }) => void;
  /** Create an overlay from an OS/Finder file dropped on this lane (HOST uploads). */
  onDropFiles?: (
    file: File,
    resolved: { kind: "image" | "video"; startTime: number; z: number; group?: string },
  ) => void;
  /** Called with the target frame when a bar is clicked (no-move). */
  onSeekFrame?: (frame: number) => void;
  /** Right-click an overlay bar — opens the timeline clip menu. */
  onOverlayContextMenu?: (id: string, x: number, y: number) => void;
  /** overlayId → display text to show inside the bar (text overlays only). */
  labelById?: Record<string, string>;
  /** overlayId → resolved media background (image content / video filmstrip).
   *  Absent / null leaves the bar's solid color fallback. */
  mediaPaintById?: Record<string, MediaPaint | null>;
  /** overlayId → sorted normalized-t keyframe union (drives the diamonds). */
  keyframeTsById?: Record<string, number[]>;
  /** Composition-global playhead time (seconds) — remapped to each bar's own
   *  window to highlight the diamond under the playhead. */
  playheadSec?: number;
  /** The currently-selected keyframe `{ overlayId, t }`, or null. */
  selectedKeyframe?: { overlayId: string; t: number } | null;
  /** Click a diamond → select that keyframe (and its overlay). */
  onSelectKeyframe?: (overlayId: string, t: number) => void;
  /** Right-click a diamond → open the keyframe-scoped menu. */
  onKeyframeContextMenu?: (overlayId: string, t: number, x: number, y: number) => void;
  /** Row height in px (Plan-D vertical stretch). When set, the lane body fills
   *  it and each sub-lane is `rowHeight / subLaneCount`. Absent → base lane. */
  rowHeight?: number;
  /** Overlay id just created (drop/add) — its bar plays a one-shot enter animation. */
  justAddedId?: string | null;
}

/** Default new-overlay duration (seconds) — sizes the drop ghost bar. Mirrors
 *  DEFAULT_OVERLAY_DURATION in lib/overlays/new-overlay-defaults.ts. */
const GHOST_BAR_SECONDS = 3;

function kindFromContentType(contentType: string): "image" | "video" {
  return contentType.startsWith("video") ? "video" : "image";
}

/** Just the lane for one overlay group. The rail (label + collapse toggle) is
 *  rendered by the parent Timeline alongside this. */
export function TimelineOverlayRow({
  row,
  timingById,
  view,
  collapsed,
  onSelect,
  onCommitTiming,
  onCrossRow,
  rowDeltaFromPointer,
  onDragHover,
  onDragEnd,
  onCoupledDragMove,
  onCoupledDragEnd,
  coupledDrag,
  durationSec = 0,
  rowGroup,
  rowZ = 0,
  onDropCreate,
  onDropFiles,
  onSeekFrame,
  onOverlayContextMenu,
  labelById,
  mediaPaintById,
  keyframeTsById,
  playheadSec,
  selectedKeyframe,
  onSelectKeyframe,
  onKeyframeContextMenu,
  rowHeight,
  justAddedId,
}: TimelineOverlayRowProps) {
  const laneRef = useRef<HTMLDivElement>(null);
  const [ghostX, setGhostX] = useState<number | null>(null);
  const [ghostLaneW, setGhostLaneW] = useState(0);
  const droppable = Boolean(onDropCreate || onDropFiles);
  // Ghost bar width = the default new-overlay duration mapped to this lane's px.
  const ghostBarW =
    durationSec > 0 && ghostLaneW > 0
      ? Math.min(1, GHOST_BAR_SECONDS / durationSec) * ghostLaneW
      : 64;

  const subLaneCount = Math.max(1, row.subLaneCount);
  // Plan-D: the lane body fills the distributed rowHeight (≥ subLaneCount*base by
  // construction); each sub-lane is rowHeight/subLaneCount so bars scale taller.
  // Collapsed always shows the base single lane. Absent rowHeight → base lane.
  const bodyHeight = collapsed
    ? ROW_PIXEL_HEIGHT
    : rowHeight != null
      ? rowHeight
      : subLaneCount * ROW_PIXEL_HEIGHT;
  const subLaneHeight = collapsed
    ? ROW_PIXEL_HEIGHT
    : rowHeight != null
      ? rowHeight / subLaneCount
      : ROW_PIXEL_HEIGHT;

  const handleSeek = useCallback(
    (clientX: number) => {
      if (!onSeekFrame) return;
      const rect = laneRef.current?.getBoundingClientRect();
      if (!rect) return;
      onSeekFrame(seekFrameFromClick({ clientX, laneLeft: rect.left, view }));
    },
    [onSeekFrame, view],
  );

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!droppable) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const rect = laneRef.current?.getBoundingClientRect();
    if (rect) {
      setGhostLaneW(rect.width);
      setGhostX(Math.min(rect.width, Math.max(0, e.clientX - rect.left)));
    }
  };

  const handleDragLeave = () => {
    if (!droppable) return;
    setGhostX(null);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!droppable) return;
    setGhostX(null);
    const lane = laneRef.current;
    if (!lane) return;
    const domRect = lane.getBoundingClientRect();
    const laneRect = { left: domRect.left, width: domRect.width };

    const libi = e.dataTransfer.getData(LIBI_FILE_MIME);
    if (libi) {
      const payload = decodeFileDrag(libi);
      if (payload) {
        const kind = kindFromContentType(payload.contentType);
        const r = resolveDrop({ clientX: e.clientX, laneRect, durationSec, rowGroup, rowZ });
        onDropCreate?.({ kind, fileId: payload.fileId, startTime: r.startTime, z: r.z, group: r.group });
      }
      e.preventDefault();
      return;
    }

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      const file = files[0];
      const kind = kindFromContentType(file.type);
      const r = resolveDrop({ clientX: e.clientX, laneRect, durationSec, rowGroup, rowZ });
      onDropFiles?.(file, { kind, startTime: r.startTime, z: r.z, group: r.group });
    }
    e.preventDefault();
  };

  return (
    <div
      ref={laneRef}
      className={`relative flex-1 rounded transition-colors ${
        ghostX != null ? "bg-primary/10 ring-1 ring-inset ring-primary/50" : "bg-background/60"
      }`}
      style={{ height: bodyHeight }}
      data-testid={`overlay-lane-${rowGroup ?? "ungrouped"}`}
      onDragOver={droppable ? handleDragOver : undefined}
      onDragLeave={droppable ? handleDragLeave : undefined}
      onDrop={droppable ? handleDrop : undefined}
    >
      {ghostX != null && (
        <div
          data-testid={`overlay-lane-ghost-${rowGroup ?? "ungrouped"}`}
          className="pointer-events-none absolute top-0.5 bottom-0.5 z-30 rounded-sm border border-primary/70 bg-primary/25"
          style={{ left: Math.max(0, Math.min(ghostX, ghostLaneW - ghostBarW)), width: ghostBarW }}
        />
      )}
      {collapsed ? (
        <div className="flex h-full items-center px-2 text-[10px] text-muted-foreground">
          {row.group} ×{row.layers.length}
        </div>
      ) : (
        row.layers.map((l) => {
          const timing = timingById[l.id];
          if (!timing) return null;
          // Playhead → this bar's normalized window (0→1), or null when outside.
          const playheadT =
            playheadSec != null && timing.duration > 0
              ? playheadSec >= timing.startTime &&
                playheadSec <= timing.startTime + timing.duration
                ? (playheadSec - timing.startTime) / timing.duration
                : null
              : null;
          const bar: OverlayBarModel = {
            id: l.id,
            kind: l.kind,
            label: labelById?.[l.id],
            startTime: timing.startTime,
            duration: timing.duration,
            subLane: l.subLane,
            selected: l.selected,
            hidden: l.hidden,
            locked: l.locked,
          };
          return (
            <OverlayBar
              key={l.id}
              bar={bar}
              view={view}
              subLaneHeight={subLaneHeight}
              justAdded={justAddedId != null && l.id === justAddedId}
              onSelect={onSelect}
              onCommitTiming={onCommitTiming}
              onCrossRow={onCrossRow}
              rowDeltaFromPointer={rowDeltaFromPointer}
              onDragHover={onDragHover}
              onDragEnd={onDragEnd}
              onCoupledDragMove={onCoupledDragMove}
              onCoupledDragEnd={onCoupledDragEnd}
              coupledDrag={coupledDrag}
              onSeekToTime={onSeekFrame ? handleSeek : undefined}
              onContextMenu={onOverlayContextMenu}
              mediaPaint={mediaPaintById?.[l.id] ?? null}
              keyframeTs={keyframeTsById?.[l.id]}
              playheadT={playheadT}
              selectedKeyframeT={
                selectedKeyframe?.overlayId === l.id ? selectedKeyframe.t : null
              }
              onSelectKeyframe={onSelectKeyframe}
              onKeyframeContextMenu={onKeyframeContextMenu}
            />
          );
        })
      )}
    </div>
  );
}
