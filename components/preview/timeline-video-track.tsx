"use client";

import { useRef } from "react";
import { ROW_PIXEL_HEIGHT } from "@/components/preview/overlay-bar";
import { sceneSegments } from "@/lib/preview/scene-segments";
import { seekFrameFromClick } from "@/lib/preview/timeline-seek";
import type { MediaPaint } from "@/lib/preview/timeline-media";

// Sage palette (mirrors the former timeline scene colors).
const SCENE_COLORS = [
  "bg-[color:var(--chart-1)]/40",
  "bg-[color:var(--chart-2)]/40",
  "bg-[color:var(--chart-3)]/40",
  "bg-[color:var(--chart-4)]/40",
  "bg-[color:var(--chart-5)]/40",
  "bg-foreground/20",
];

interface TimelineVideoTrackProps {
  scenes: { id: string; name: string; type: "canvas" }[];
  fps: number;
  totalFrames: number;
  /** sceneId → duration (seconds) from the live composition. */
  durations: Record<string, number>;
  selectedId: string | null;
  onSelect: (sceneId: string) => void;
  onContextMenu: (sceneId: string, x: number, y: number) => void;
  /** Called with the target frame when a scene block is clicked. */
  onSeekFrame?: (frame: number) => void;
  /** Row height in px (Plan-D vertical stretch). Defaults to the base lane. */
  height?: number;
}

export function TimelineVideoTrack({
  scenes,
  fps,
  totalFrames,
  durations,
  selectedId,
  onSelect,
  onContextMenu,
  onSeekFrame,
  height = ROW_PIXEL_HEIGHT,
}: TimelineVideoTrackProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const segs = sceneSegments(
    scenes.map((s) => ({ id: s.id, name: s.name, duration: durations[s.id] ?? 0 })),
    fps,
    totalFrames,
  );

  const handleBlockClick = (segId: string, clientX: number) => {
    onSelect(segId);
    if (onSeekFrame) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const frame = seekFrameFromClick({
          clientX,
          laneLeft: rect.left,
          view: { trackWidth: rect.width, totalFrames, fps },
        });
        onSeekFrame(frame);
      }
    }
  };

  return (
    <div
      ref={containerRef}
      className="relative flex-1 rounded bg-background/60"
      style={{ height }}
      data-testid="timeline-video-track"
    >
      {segs.map((seg, i) => {
        // Scenes are canvas-only and reference no file, so there is never a
        // filmstrip to paint into a scene block (overlay bars still paint).
        const paint = null as MediaPaint | null;
        return (
          <button
            key={seg.id}
            type="button"
            data-testid={`video-block-${seg.id}`}
            data-media={paint ? "painted" : undefined}
            onClick={(e) => handleBlockClick(seg.id, e.clientX)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onContextMenu(seg.id, e.clientX, e.clientY);
            }}
            style={{
              left: `${seg.leftPct}%`,
              width: `${seg.widthPct}%`,
              height: height - 2,
              ...(paint
                ? {
                    backgroundImage: paint.backgroundImage,
                    backgroundSize: paint.backgroundSize,
                    backgroundRepeat: paint.backgroundRepeat,
                    backgroundPosition: paint.backgroundPosition,
                  }
                : {}),
            }}
            className={`absolute top-0 flex cursor-pointer items-center overflow-hidden rounded-sm border text-[10px] ${
              paint ? "" : SCENE_COLORS[i % SCENE_COLORS.length]
            } ${
              selectedId === seg.id
                ? "border-primary text-foreground"
                : "border-border/50 text-muted-foreground hover:text-foreground"
            }`}
            title={seg.name}
          >
            <span
              className={`truncate px-1.5 ${
                paint ? "rounded-sm bg-black/55 text-white" : ""
              }`}
            >
              {seg.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}
