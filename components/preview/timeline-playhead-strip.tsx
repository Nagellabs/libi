"use client";

import type { RefObject } from "react";
import { RAIL_WIDTH } from "@/components/preview/track-rail";
import { frameToTimecode } from "@/lib/preview/timecode";
import { usePlayheadScrub } from "@/hooks/preview/use-playhead-scrub";

/** Height (px) of the sticky playhead strip — just enough for the pin. The
 *  strip's bottom edge IS the top border of the first track row (no gap,
 *  no lane box). */
export const PLAYHEAD_STRIP_H = 14;

interface TimelinePlayheadStripProps {
  totalFrames: number;
  playheadPercent: number;
  markers: { id: string; time: number }[];
  fps: number;
  currentFrame: number;
  onScrub: (frame: number) => void;
  onMarkerClick: (time: number) => void;
  /** Content lane width in px (zoom-driven renderWidth). */
  contentWidth: number;
  /** Owned by Timeline so the spanning line shares the same lane-x origin. */
  laneRef: RefObject<HTMLDivElement | null>;
  /** True while ANY playhead surface (strip, pin, line) is dragging —
   *  drives the timecode chip. */
  dragging: boolean;
  onDraggingChange: (dragging: boolean) => void;
}

/** Slim sticky strip that replaces the old ruler track: transparent scrub
 *  surface + downward pin + marker ticks, pinned to the top of the visible
 *  timeline while the tracks scroll vertically beneath it. */
export function TimelinePlayheadStrip({
  totalFrames,
  playheadPercent,
  markers,
  fps,
  currentFrame,
  onScrub,
  onMarkerClick,
  contentWidth,
  laneRef,
  dragging,
  onDraggingChange,
}: TimelinePlayheadStripProps) {
  const scrubHandlers = usePlayheadScrub({
    laneRef,
    totalFrames,
    onScrub,
    onDraggingChange,
  });

  // Chip flips to the left of the pin near the right edge so it never
  // clips outside the lane.
  const chipOnLeft = playheadPercent > 85;

  return (
    <div
      data-testid="playhead-strip-row"
      className="sticky top-0 z-[35] flex shrink-0 items-stretch"
    >
      {/* Sticky-left rail spacer (bg-surface) keeps the pin sliding UNDER
          the rail column when the lanes scroll horizontally, matching the
          track rows. */}
      <div
        style={{ width: RAIL_WIDTH, position: "sticky", left: 0 }}
        className="z-30 shrink-0 bg-surface"
      />
      <div
        ref={laneRef}
        data-testid="playhead-strip"
        {...scrubHandlers}
        style={{ width: contentWidth, height: PLAYHEAD_STRIP_H }}
        className="relative shrink-0 cursor-pointer touch-none"
      >
        {markers.map((m) => {
          const pct =
            totalFrames > 0
              ? Math.min(100, Math.max(0, ((m.time * fps) / (totalFrames - 1)) * 100))
              : 0;
          return (
            <div
              key={m.id}
              data-testid={`playhead-marker-${m.id}`}
              className="absolute inset-y-0 z-10 w-0.5 cursor-pointer bg-amber-400"
              style={{ left: `${pct}%` }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onMarkerClick(m.time);
              }}
            />
          );
        })}
        {totalFrames > 0 && (
          <div
            data-testid="playhead-pin"
            className="absolute top-0 z-20 h-full w-4 -translate-x-1/2 cursor-ew-resize"
            style={{ left: `${playheadPercent}%` }}
          >
            <svg
              width="13"
              height="14"
              viewBox="0 0 13 14"
              className="absolute left-1/2 top-0 -translate-x-1/2 fill-primary drop-shadow-md"
              aria-hidden="true"
            >
              <path d="M2 1h9a1 1 0 0 1 1 1v5.5L6.5 13 1 7.5V2a1 1 0 0 1 1-1Z" />
            </svg>
          </div>
        )}
        {dragging && totalFrames > 0 && (
          <div
            data-testid="playhead-timecode-chip"
            className="pointer-events-none absolute top-0 z-30 whitespace-nowrap rounded border border-border bg-background px-1 font-mono text-[10px] leading-[13px] text-foreground"
            style={
              chipOnLeft
                ? { right: `${100 - playheadPercent}%`, marginRight: 10 }
                : { left: `${playheadPercent}%`, marginLeft: 10 }
            }
          >
            {frameToTimecode(currentFrame, fps)}
          </div>
        )}
      </div>
    </div>
  );
}
