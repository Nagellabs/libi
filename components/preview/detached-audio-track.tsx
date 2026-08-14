"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Link2, Volume2, VolumeX } from "lucide-react";
import type { AudioClip } from "@/lib/engine/types";
import { Waveform } from "./waveform";
import { useAudioClipPosition } from "@/hooks/preview/use-audio-clip-position";
import { dragToTiming, type ClipTiming } from "@/lib/preview/audio-clip-drag";

interface DetachedAudioTrackProps {
  clip: AudioClip | undefined;
  /** The source video overlay this track was detached from (Re-attach target +
   *  "detached audio of video — X" label). */
  ownerOverlayId: string;
  /** Strip height in px. */
  height: number;
  fps: number;
  totalFrames: number;
  /** Content lane width in px (pointer px → seconds). */
  trackWidth: number;
  /** Display label (already "detached audio of video — X"). */
  label: string;
  /** The live vertical sort key for this track (for the data attribute). */
  order: number;
  selected: boolean;
  onSelect: () => void;
  onToggleEnabled: () => void;
  /** Re-attach (detached → coupled). */
  onRelink: () => void;
  onContextMenu?: (x: number, y: number) => void;
  /** Commit the CLIP's own timing AND (when reordered) its new `timelineOrder` in
   *  ONE patch — a drag is horizontal (time) + vertical (reorder THIS track only,
   *  never the video). A single patch avoids a two-PATCH lost-update race on the
   *  server (both calls load+save the manifest independently). */
  onCommit: (
    clipId: string,
    patch: { startTime: number; duration: number; timelineOrder?: number },
  ) => void;
  /** Vertical drag → the NEW timelineOrder for the drop slot (fractional indexing
   *  among the stack rows). Returns null = no vertical change. */
  resolveOrderFromPointer: (clipId: string, clientY: number) => number | null;
  /** Drop-indicator wiring (shared with the overlay reorder). */
  onDragHover?: (id: string, clientY: number) => void;
  onDragEnd?: () => void;
}

/** Drag threshold (px) before a mousedown is treated as a move (vs a click). */
const DRAG_THRESHOLD_PX = 3;

/**
 * A DETACHED audio track — a FULLY INDEPENDENT timeline row. After detach it can
 * be dragged ANYWHERE: horizontally (time) AND vertically (reordered/interleaved
 * among all the other tracks). Completely decoupled from its source video —
 * dragging the video never moves it and dragging it never moves the video. The
 * only ties to the video: it materializes directly below the video at the moment
 * of detach (server-seeded `timelineOrder`), and it keeps a Re-attach button.
 *
 * Horizontal drag uses the SAME optimistic-hold the free clips use (no flash on
 * release). Vertical drag computes a new `timelineOrder` (fractional indexing)
 * for the drop slot and commits ONLY this track's order. Dashed amber.
 */
export function DetachedAudioTrack({
  clip,
  ownerOverlayId,
  height,
  fps,
  totalFrames,
  trackWidth,
  label,
  order,
  selected,
  onSelect,
  onToggleEnabled,
  onRelink,
  onContextMenu,
  onCommit,
  resolveOrderFromPointer,
  onDragHover,
  onDragEnd,
}: DetachedAudioTrackProps) {
  void ownerOverlayId;
  const totalSeconds = fps > 0 ? totalFrames / fps : 0;
  const enabled = clip?.enabled ?? true;

  // Position source: the CLIP's own timing, held through the server round-trip by
  // the optimistic-hold hook so a horizontal drag never flashes back to the stale
  // persisted start on release.
  const clipProp: ClipTiming = {
    startTime: clip?.startTime ?? 0,
    duration: clip?.duration ?? 0,
  };
  const { display: heldClip, hold } = useAudioClipPosition(clipProp);
  const baseStart = heldClip.startTime;
  const baseDuration = heldClip.duration;

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
      let newOrder: number | null = null;
      const move = (ev: MouseEvent) => {
        if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > DRAG_THRESHOLD_PX) moved = true;
        const next = dragToTiming({ startTime: start0, duration: dur0 }, ev.clientX - downX, pxPerSec);
        dsec = next.startTime - start0;
        const dy = ev.clientY - downY;
        if (moved) {
          setDragSec(dsec);
          setDragDy(dy);
          // Show the drop indicator + compute the new vertical order for THIS
          // track only (never the video).
          onDragHover?.(clip.id, ev.clientY);
          newOrder = resolveOrderFromPointer(clip.id, ev.clientY);
        }
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        setDragSec(null);
        setDragDy(0);
        onDragEnd?.();
        if (!moved) {
          onSelect();
          return;
        }
        // Commit the CLIP's own start (horizontal) + its new timelineOrder
        // (vertical reorder of THIS track only) in ONE patch — HOLD the timing
        // until the server composition reflects it (no flash on release).
        const committed = { startTime: start0 + dsec, duration: dur0 };
        hold(committed);
        onCommit(clip.id, {
          ...committed,
          ...(newOrder != null ? { timelineOrder: newOrder } : {}),
        });
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [
      clip,
      totalSeconds,
      trackWidth,
      onCommit,
      resolveOrderFromPointer,
      onDragHover,
      onDragEnd,
      onSelect,
      hold,
    ],
  );

  const effectiveSec = dragSec ?? 0;
  const dyPx = dragSec != null ? dragDy : 0;
  const moving = dragSec != null;
  const startSec = baseStart + effectiveSec;
  const leftPct = totalSeconds > 0 ? (startSec / totalSeconds) * 100 : 0;
  const widthPct = totalSeconds > 0 ? (baseDuration / totalSeconds) * 100 : 0;

  const tone = !enabled
    ? "border-l-foreground/30 bg-foreground/10 text-muted-foreground"
    : "border-dashed border-amber-400/70 bg-amber-500/15 text-foreground";

  return (
    <div
      className="relative rounded bg-background/40"
      style={{ height }}
      data-testid="detached-audio-track"
      data-clip-id={clip?.id}
      data-audio-track-order={order}
    >
      <div
        data-testid={`detached-audio-${clip?.id ?? "none"}`}
        onMouseDown={startDrag}
        onContextMenu={(e) => {
          if (!onContextMenu) return;
          e.preventDefault();
          onContextMenu(e.clientX, e.clientY);
        }}
        className={`absolute top-0 flex h-full cursor-grab items-center gap-1 overflow-hidden rounded border-l-2 px-1 text-[9px] ${tone} ${
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
            onRelink();
          }}
          className="relative z-10 ml-auto shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
          title="Re-attach audio to its video"
        >
          <Link2 className="size-3" />
        </button>
      </div>
    </div>
  );
}
