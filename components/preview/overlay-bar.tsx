"use client";

import { useCallback, useState } from "react";
import {
  laneBarRect,
  clampBarTiming,
  type LaneView,
} from "@/lib/preview/lane-bar-geometry";
import type { MediaPaint } from "@/lib/preview/timeline-media";
import type { SelectionModifiers } from "@/lib/preview/selection-logic";
import { keyframeMarkerX, isKeyframeAtPlayhead } from "@/lib/preview/keyframe-markers";

export interface OverlayBarModel {
  id: string;
  kind: string;
  /** Optional text to display inside the bar; falls back to `kind` when absent. */
  label?: string;
  startTime: number;
  duration: number;
  subLane: number;
  selected: boolean;
  hidden: boolean;
  locked: boolean;
}

interface OverlayBarProps {
  bar: OverlayBarModel;
  view: LaneView;
  /** Row height each sub-lane occupies (px). */
  subLaneHeight: number;
  /** True for a just-created bar (drop/add) — plays a one-shot enter animation. */
  justAdded?: boolean;
  /** Select this bar (shared SelectionStore via parent). `mods` carries the
   *  shift/cmd modifiers from the mousedown for multi-select. */
  onSelect: (id: string, mods?: SelectionModifiers) => void;
  /** Commit a new [startTime,duration] after a move/trim drag. */
  onCommitTiming: (id: string, timing: { startTime: number; duration: number }) => void;
  /** Commit a row change (delta rows; +1 = one row toward front). */
  onCrossRow: (id: string, deltaRows: number) => void;
  /** Resolve the cross-row delta from the pointer's absolute Y against the REAL
   *  (variable-height) rendered rows. Preferred over the fixed-height estimate so
   *  a drag across tall media rows counts the rows actually crossed. Absent →
   *  fall back to the constant-height estimate. */
  rowDeltaFromPointer?: (id: string, clientY: number) => number;
  /** Live during a vertical (move) drag: report the pointer Y so the timeline can
   *  draw a drop-position indicator at the row the item will land on. */
  onDragHover?: (id: string, clientY: number) => void;
  /** Drag ended (release/cancel) — clear the drop indicator. */
  onDragEnd?: () => void;
  /** Publish this bar's live drag offset (horizontal seconds + vertical px) so a
   *  coupled audio strip moves AND lifts WITH the video during the drag. */
  onCoupledDragMove?: (ownerOverlayId: string, deltaSec: number, dy: number) => void;
  /** Clear the published coupled-drag offset on release. */
  onCoupledDragEnd?: () => void;
  /** The sibling's live coupled-drag (when the COUPLED AUDIO is being dragged,
   *  this bar mirrors it horizontally + vertically). */
  coupledDrag?: { ownerOverlayId: string; deltaSec: number; dy: number } | null;
  /** Called with the mousedown clientX when a no-move click happens — seek the playhead. */
  onSeekToTime?: (clientX: number) => void;
  /** Right-click this bar — opens the timeline clip menu (cut/duplicate/delete). */
  onContextMenu?: (id: string, x: number, y: number) => void;
  /** Optional media background (image content / video filmstrip sprite). When
   *  absent the bar keeps its solid color fallback. */
  mediaPaint?: MediaPaint | null;
  /** Keyframe diamond markers — the sorted normalized-t union
   *  (`overlayKeyframeTimes`). Absent/empty ⇒ no diamonds. */
  keyframeTs?: number[];
  /** The playhead's NORMALIZED time within THIS bar's window (0→1), or null
   *  when the playhead is outside the bar. Highlights the diamond under it. */
  playheadT?: number | null;
  /** The currently-selected keyframe's normalized t on THIS overlay, or null. */
  selectedKeyframeT?: number | null;
  /** Click a diamond → select that keyframe (and the overlay). */
  onSelectKeyframe?: (overlayId: string, t: number) => void;
  /** Right-click a diamond → open the keyframe-scoped menu (edit easing / delete
   *  this keyframe / clear all) — kept OFF the clip bar menu. */
  onKeyframeContextMenu?: (overlayId: string, t: number, x: number, y: number) => void;
}

type Mode = "move" | "trim-l" | "trim-r";

/** Row pixel height — used to convert a vertical drag into a row delta. */
export const ROW_PIXEL_HEIGHT = 28;

export function OverlayBar({
  bar,
  view,
  subLaneHeight,
  onSelect,
  onCommitTiming,
  onCrossRow,
  rowDeltaFromPointer,
  onDragHover,
  onDragEnd,
  onCoupledDragMove,
  onCoupledDragEnd,
  coupledDrag,
  onSeekToTime,
  onContextMenu,
  mediaPaint,
  keyframeTs,
  playheadT,
  selectedKeyframeT,
  onSelectKeyframe,
  onKeyframeContextMenu,
  justAdded,
}: OverlayBarProps) {
  const { leftPx, widthPx } = laneBarRect(bar, view);
  const totalSeconds = view.fps > 0 ? view.totalFrames / view.fps : 0;

  // Live optimistic drag state: while dragging, the bar follows the pointer at
  // 60fps from LOCAL state (re-rendering only itself — no network round-trip), so
  // editing feels instant. On release the real commit lands in the optimistic
  // edit store (so the bar holds its new position with no flash); clearing this
  // state with the transition enabled animates the "drop into place".
  const [drag, setDrag] = useState<{ leftPx: number; widthPx: number; dy: number } | null>(null);

  const startDrag = useCallback(
    (mode: Mode, e: React.MouseEvent) => {
      // Only the LEFT button drags/selects/seeks. A right-click must not move the
      // playhead — it just opens the context menu (separate onContextMenu). The
      // stray seek made "Cut at playhead" flip disabled→enabled after the menu
      // opened (the playhead jumped INTO the clicked clip), flickering the item.
      if (e.button !== 0) return;
      if (bar.locked) return;
      e.preventDefault();
      e.stopPropagation();
      onSelect(bar.id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
      const downX = e.clientX;
      const downY = e.clientY;
      const start0 = bar.startTime;
      const dur0 = bar.duration;
      let moved = false;
      let lastTiming = { startTime: start0, duration: dur0 };
      let rowDelta = 0;

      const move = (ev: MouseEvent) => {
        if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 3) moved = true;
        const deltaSec =
          (ev.clientX - downX) *
          (totalSeconds > 0 && view.trackWidth > 0 ? totalSeconds / view.trackWidth : 0);
        if (mode === "move") {
          lastTiming = clampBarTiming({ startTime: start0 + deltaSec, duration: dur0 }, totalSeconds);
          // Prefer the real-layout resolver (handles variable row heights); fall
          // back to the fixed-height estimate when it isn't supplied.
          rowDelta = rowDeltaFromPointer
            ? rowDeltaFromPointer(bar.id, ev.clientY)
            : -Math.round((ev.clientY - downY) / ROW_PIXEL_HEIGHT); // up = toward front (+)
        } else if (mode === "trim-l") {
          const newStart = start0 + deltaSec;
          lastTiming = clampBarTiming({ startTime: newStart, duration: dur0 - deltaSec }, totalSeconds);
        } else {
          lastTiming = clampBarTiming({ startTime: start0, duration: dur0 + deltaSec }, totalSeconds);
        }
        // Live optimistic position (this bar re-renders only itself).
        if (moved) {
          const r = laneBarRect(
            { ...bar, startTime: lastTiming.startTime, duration: lastTiming.duration },
            view,
          );
          setDrag({ leftPx: r.leftPx, widthPx: r.widthPx, dy: mode === "move" ? ev.clientY - downY : 0 });
          if (mode === "move") {
            // Show the drop-position indicator for a vertical reorder...
            onDragHover?.(bar.id, ev.clientY);
            // ...and publish the horizontal shift + vertical lift so a coupled
            // audio strip moves AND lifts WITH the video live (not just landing).
            onCoupledDragMove?.(bar.id, lastTiming.startTime - start0, ev.clientY - downY);
          }
        }
      };

      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        setDrag(null); // clearing with the transition enabled animates the landing
        onDragEnd?.();
        onCoupledDragEnd?.();
        if (!moved) {
          // Selection already happened on mousedown (startDrag). A plain click
          // additionally seeks the playhead to the time under the cursor.
          onSeekToTime?.(downX);
          return;
        }
        if (rowDelta !== 0 && mode === "move") onCrossRow(bar.id, rowDelta);
        if (lastTiming.startTime !== start0 || lastTiming.duration !== dur0) {
          onCommitTiming(bar.id, lastTiming);
        }
      };

      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [bar, view, totalSeconds, onSelect, onCommitTiming, onCrossRow, rowDeltaFromPointer, onDragHover, onDragEnd, onCoupledDragMove, onCoupledDragEnd, onSeekToTime],
  );

  // Mirror a sibling's coupled drag (the audio strip being dragged moves this
  // video bar). Only when NOT self-dragging; pure horizontal offset.
  const pxPerSec = totalSeconds > 0 && view.trackWidth > 0 ? view.trackWidth / totalSeconds : 0;
  const isMirror = !drag && !!coupledDrag && coupledDrag.ownerOverlayId === bar.id;
  const mirrorSec = isMirror ? coupledDrag!.deltaSec : 0;
  const mirrorDy = isMirror ? coupledDrag!.dy : 0;
  const mirroring = isMirror && (mirrorSec !== 0 || mirrorDy !== 0);

  const painted = !!mediaPaint;
  // Bar width the diamonds scale against — the LIVE rendered width (follows a
  // drag), floored the same way the element's style width is.
  const barW = Math.max(6, drag ? drag.widthPx : widthPx);
  const kfTs = keyframeTs ?? [];
  const barDurationSec = bar.duration;
  // Keep edge keyframe diamonds fully inside the overflow-hidden bar (INSET), and
  // when one lands in the left gutter push the label right so a t=0 keyframe is
  // never hidden behind the label text.
  const KF_INSET_PX = 8;
  const KF_LABEL_GUTTER_PX = 18;
  const startKfInGutter =
    barW > 0 && kfTs.some((t) => keyframeMarkerX(t, barW, KF_INSET_PX) <= KF_LABEL_GUTTER_PX);
  return (
    <div
      data-testid={`overlay-bar-${bar.id}`}
      data-media={painted ? "painted" : undefined}
      onMouseDown={(e) => startDrag("move", e)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu?.(bar.id, e.clientX, e.clientY);
      }}
      className={`absolute flex items-center overflow-hidden rounded-sm border text-[10px] ${
        bar.selected
          ? "border-primary text-foreground"
          : painted
            ? "border-border text-foreground"
            : "border-border bg-foreground/15 text-muted-foreground hover:bg-foreground/25"
      } ${!painted && bar.selected ? "bg-primary/25" : ""} ${bar.hidden ? "opacity-40" : ""} ${bar.locked ? "cursor-not-allowed" : "cursor-grab"} ${justAdded ? "animate-in fade-in zoom-in-95 duration-300" : ""}`}
      style={{
        left: drag ? drag.leftPx : leftPx + mirrorSec * pxPerSec,
        width: Math.max(6, drag ? drag.widthPx : widthPx),
        top: bar.subLane * subLaneHeight,
        height: subLaneHeight - 2,
        // While dragging: follow the pointer 1:1 (no transition), lift + raise.
        // When mirroring a coupled audio drag: also follow live (no transition).
        // On release (drag → null): the transition animates back to rest = the
        // "drop into place" landing.
        transform: drag
          ? `translateY(${drag.dy}px) scale(1.03)`
          : mirroring
            ? `translateY(${mirrorDy}px) scale(1.02)`
            : "translateY(0) scale(1)",
        transition: drag || mirroring ? "none" : "left 160ms ease, width 160ms ease, transform 180ms ease",
        zIndex: drag ? 50 : undefined,
        boxShadow: drag ? "0 6px 16px rgba(0,0,0,0.45)" : undefined,
        ...(mediaPaint
          ? {
              backgroundImage: mediaPaint.backgroundImage,
              backgroundSize: mediaPaint.backgroundSize,
              backgroundRepeat: mediaPaint.backgroundRepeat,
              backgroundPosition: mediaPaint.backgroundPosition,
            }
          : {}),
      }}
      title={`${bar.kind} — ${bar.startTime.toFixed(2)}s..${(bar.startTime + bar.duration).toFixed(2)}s`}
    >
      {/* Left trim edge */}
      {!bar.locked && (
        <div
          data-testid={`overlay-bar-${bar.id}-trim-l`}
          onMouseDown={(e) => startDrag("trim-l", e)}
          className="absolute left-0 top-0 z-10 h-full w-1.5 cursor-ew-resize bg-primary/50"
        />
      )}
      {/* Legibility scrim behind the label when media is painted. */}
      <span
        className={`relative truncate px-2 ${
          painted ? "rounded-sm bg-black/55 text-white" : ""
        }`}
        style={startKfInGutter ? { marginLeft: KF_LABEL_GUTTER_PX } : undefined}
      >
        {bar.label ?? bar.kind}
      </span>
      {/* Keyframe diamonds — a pointer-events layer on TOP of the label/media,
          one rotated square per keyframe time. Highlighted when at the playhead
          or when it is the selected keyframe. */}
      {kfTs.length > 0 && (
        <div
          data-testid={`overlay-bar-${bar.id}-keyframes`}
          className="pointer-events-none absolute inset-0 z-20"
        >
          {kfTs.map((t) => {
            const x = keyframeMarkerX(t, barW, KF_INSET_PX);
            const atPlayhead =
              playheadT != null &&
              isKeyframeAtPlayhead(t, playheadT, barDurationSec, view.fps);
            const isSelected = selectedKeyframeT != null && selectedKeyframeT === t;
            const active = atPlayhead || isSelected;
            return (
              <button
                key={t}
                type="button"
                data-testid={`overlay-bar-${bar.id}-kf-${t}`}
                data-active={active ? "true" : undefined}
                title={`Keyframe @ ${(t * barDurationSec).toFixed(2)}s`}
                onMouseDown={(e) => {
                  // Don't let the diamond start a bar move/select drag.
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onSelectKeyframe?.(bar.id, t);
                }}
                onContextMenu={(e) => {
                  // Keyframe-scoped menu — stop the bar's clip menu from also firing.
                  e.preventDefault();
                  e.stopPropagation();
                  onKeyframeContextMenu?.(bar.id, t, e.clientX, e.clientY);
                }}
                className={`pointer-events-auto absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-pointer rounded-[1px] border ${
                  active
                    ? "border-primary bg-primary shadow-[0_0_4px_var(--color-primary,#6366f1)]"
                    : "border-primary/70 bg-background"
                }`}
                style={{ left: x }}
              />
            );
          })}
        </div>
      )}
      {/* Right trim edge */}
      {!bar.locked && (
        <div
          data-testid={`overlay-bar-${bar.id}-trim-r`}
          onMouseDown={(e) => startDrag("trim-r", e)}
          className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-ew-resize bg-primary/50"
        />
      )}
    </div>
  );
}
