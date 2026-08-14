"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Unlink, Volume2, VolumeX } from "lucide-react";
import type { AudioClip } from "@/lib/engine/types";
import { Waveform } from "./waveform";
import { dragToTiming } from "@/lib/preview/audio-clip-drag";

interface CoupledAudioStripProps {
  clip: AudioClip | undefined;
  /** The video overlay this audio belongs to. */
  ownerOverlayId: string;
  /** The OWNER VIDEO's current (optimistic) start/duration in seconds. The strip
   *  positions by THESE (so it tracks the video's optimistic drag with no
   *  snap-back). */
  ownerStartSec: number;
  ownerDurationSec: number;
  /** Strip height in px. */
  height: number;
  fps: number;
  totalFrames: number;
  /** Content lane width in px (pointer px → seconds). */
  trackWidth: number;
  /** Display label (already "audio of video — X"). */
  label: string;
  selected: boolean;
  onSelect: () => void;
  onToggleEnabled: () => void;
  /** Detach (coupled) → standalone (independent track). */
  onDetach: () => void;
  onContextMenu?: (x: number, y: number) => void;
  /** Drag → commit the OWNER VIDEO's timing (the clip resyncs). */
  onCommitVideoTiming: (overlayId: string, timing: { startTime: number; duration: number }) => void;
  /** Publish live drag offset (horizontal seconds + vertical px) so the video bar
   *  mirrors it. */
  onCoupledDragMove?: (ownerOverlayId: string, deltaSec: number, dy: number) => void;
  onCoupledDragEnd?: () => void;
  /** Sibling's live coupled-drag (video being dragged → the strip mirrors). */
  coupledDrag?: { ownerOverlayId: string; deltaSec: number; dy: number } | null;
  /** Vertical (between-track) reorder of the OWNER VIDEO when this strip is
   *  dragged up/down — dragging the audio moves the pair vertically. */
  rowDeltaFromPointer?: (ownerOverlayId: string, clientY: number) => number;
  onCrossRow?: (ownerOverlayId: string, deltaRows: number) => void;
  onDragHover?: (ownerOverlayId: string, clientY: number) => void;
  onDragEnd?: () => void;
}

/** Drag threshold (px) before a mousedown is treated as a move (vs a click). */
const DRAG_THRESHOLD_PX = 3;

/**
 * A video overlay's COUPLED (inline) audio, rendered as a slim strip DIRECTLY
 * under the video. Positions by the VIDEO's optimistic timing; dragging it IS
 * dragging the video (moves both live, commits the video). Vertical drag reorders
 * the video pair together (correct for coupled). Solid blue. Unlink detaches it
 * (→ an independent DetachedAudioTrack row). DETACHED audio is NOT this
 * component — see `detached-audio-track.tsx`.
 */
export function CoupledAudioStrip({
  clip,
  ownerOverlayId,
  ownerStartSec,
  ownerDurationSec,
  height,
  fps,
  totalFrames,
  trackWidth,
  label,
  selected,
  onSelect,
  onToggleEnabled,
  onDetach,
  onContextMenu,
  onCommitVideoTiming,
  onCoupledDragMove,
  onCoupledDragEnd,
  coupledDrag,
  rowDeltaFromPointer,
  onCrossRow,
  onDragHover,
  onDragEnd,
}: CoupledAudioStripProps) {
  const totalSeconds = fps > 0 ? totalFrames / fps : 0;
  const enabled = clip?.enabled ?? true;

  // ── Position source ──────────────────────────────────────────────────────
  // Follow the VIDEO's (optimistic) window so the strip tracks the video's drag
  // with no snap-back.
  const baseStart = ownerStartSec;
  const baseDuration = ownerDurationSec;

  // Live local drag offset (seconds) + vertical lift (px) while self-dragging.
  const [dragSec, setDragSec] = useState<number | null>(null);
  const [dragDy, setDragDy] = useState(0);
  // Latest base values for the mousedown closure (avoid re-binding on every
  // move). Written in an effect (never during render); mousedown only fires
  // post-commit, so it always sees the committed values.
  const baseRef = useRef({ start: baseStart, duration: baseDuration });
  useEffect(() => {
    baseRef.current = { start: baseStart, duration: baseDuration };
  });

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      // Left button only — a right-click just opens the context menu (no seek).
      if (e.button !== 0) return;
      if (!clip) return;
      e.preventDefault();
      e.stopPropagation();
      const downX = e.clientX;
      const downY = e.clientY;
      const start0 = baseRef.current.start;
      const dur0 = baseRef.current.duration;
      const pxPerSec = totalSeconds > 0 && trackWidth > 0 ? trackWidth / totalSeconds : 0;
      let moved = false;
      let dsec = 0;
      let rowDelta = 0;
      const move = (ev: MouseEvent) => {
        if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > DRAG_THRESHOLD_PX) moved = true;
        const next = dragToTiming({ startTime: start0, duration: dur0 }, ev.clientX - downX, pxPerSec);
        dsec = next.startTime - start0;
        const dy = ev.clientY - downY;
        if (moved) {
          setDragSec(dsec);
          setDragDy(dy);
          // Move + lift the video bar live (publish to the mirror). Show the drop
          // indicator + compute the cross-row reorder of the OWNER VIDEO (dragging
          // the coupled audio reorders the pair vertically).
          onCoupledDragMove?.(ownerOverlayId, dsec, dy);
          onDragHover?.(ownerOverlayId, ev.clientY);
          rowDelta = rowDeltaFromPointer ? rowDeltaFromPointer(ownerOverlayId, ev.clientY) : 0;
        }
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        setDragSec(null);
        setDragDy(0);
        onCoupledDragEnd?.();
        onDragEnd?.();
        if (!moved) {
          onSelect();
          return;
        }
        // Vertical reorder of the OWNER VIDEO (pair moves together vertically).
        if (rowDelta !== 0) onCrossRow?.(ownerOverlayId, rowDelta);
        // Dragging commits the VIDEO's start; the clip resyncs.
        onCommitVideoTiming(ownerOverlayId, { startTime: start0 + dsec, duration: dur0 });
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [
      clip,
      ownerOverlayId,
      totalSeconds,
      trackWidth,
      onCoupledDragMove,
      onCoupledDragEnd,
      onCommitVideoTiming,
      onCrossRow,
      onDragHover,
      onDragEnd,
      rowDeltaFromPointer,
      onSelect,
    ],
  );

  // The strip mirrors the video's drag (when the VIDEO is being dragged).
  const mirror =
    dragSec == null && coupledDrag && coupledDrag.ownerOverlayId === ownerOverlayId
      ? coupledDrag
      : null;
  const effectiveSec = dragSec != null ? dragSec : mirror ? mirror.deltaSec : 0;
  const dyPx = dragSec != null ? dragDy : mirror ? mirror.dy : 0;
  const moving = dragSec != null || effectiveSec !== 0 || dyPx !== 0;
  const startSec = baseStart + effectiveSec;
  const leftPct = totalSeconds > 0 ? (startSec / totalSeconds) * 100 : 0;
  const widthPct = totalSeconds > 0 ? (baseDuration / totalSeconds) * 100 : 0;

  const tone = !enabled
    ? "border-l-foreground/30 bg-foreground/10 text-muted-foreground"
    : "border-l-blue-400 bg-blue-500/20 text-foreground";

  return (
    <div className="relative -mt-1 rounded-b bg-background/40" style={{ height }}>
      <div
        data-testid={`coupled-audio-${clip?.id ?? "none"}`}
        data-attached="true"
        onMouseDown={startDrag}
        onContextMenu={(e) => {
          if (!onContextMenu) return;
          e.preventDefault();
          onContextMenu(e.clientX, e.clientY);
        }}
        className={`absolute top-0 flex h-full cursor-grab items-center gap-1 overflow-hidden rounded-b border-l-2 px-1 text-[9px] ${tone} ${
          selected ? "ring-1 ring-primary" : ""
        }`}
        style={{
          left: `${leftPct}%`,
          width: `max(${widthPct}%, 24px)`,
          transform: `translateY(${dyPx}px)`,
          zIndex: dyPx !== 0 ? 50 : undefined,
          transition: moving ? "none" : "left 160ms ease, transform 160ms ease",
        }}
        title={label}
      >
        {clip && (
          <div className="pointer-events-none absolute inset-0 opacity-60">
            <Waveform
              fileId={clip.fileId}
              trimStart={clip.trimStart}
              duration={clip.duration}
              color={enabled ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.25)"}
            />
          </div>
        )}
        <button
          type="button"
          onMouseDown={(e) => {
            e.stopPropagation();
            onToggleEnabled();
          }}
          className="relative z-10 shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
          title={enabled ? "Mute" : "Unmute"}
        >
          {enabled ? <Volume2 className="size-3" /> : <VolumeX className="size-3" />}
        </button>
        <span className="relative z-10 truncate">{label}</span>
        <button
          type="button"
          onMouseDown={(e) => {
            e.stopPropagation();
            onDetach();
          }}
          className="relative z-10 ml-auto shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
          title="Detach audio from video (independent track)"
        >
          <Unlink className="size-3" />
        </button>
      </div>
    </div>
  );
}
