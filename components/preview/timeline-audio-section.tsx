"use client";

import { useMemo } from "react";
import type { AudioClip } from "@/lib/engine/types";
import { activeClipsAt } from "@/lib/audio/active-clips";
import { maxOverlap } from "@/lib/audio/overlap";
import AudioClipRow from "./audio-clip-row";

interface TimelineAudioSectionProps {
  clips: AudioClip[];
  fps: number;
  currentFrame: number;
  totalFrames: number;
  /** Each row is one clip, rendered as a horizontal bar over the row's lane. */
  onToggleClipEnabled: (clipId: string) => void;
  onClipContextMenu: (clipId: string, x: number, y: number) => void;
  /** Currently-selected id (single selection space) — highlights its bar. */
  selectedId?: string | null;
  /** Click a bar to select the clip for the inspector. */
  onSelectClip?: (clipId: string) => void;
  /** Row height in px (Plan-D vertical stretch). When set, the section fills it
   *  and the per-clip rows share it; absent → natural per-clip heights. */
  height?: number;
  /** Content lane width in px (for clip drag → seconds). */
  trackWidth?: number;
  /** Commit a clip's own timing after a horizontal drag. */
  onCommitClipTiming?: (clipId: string, timing: { startTime: number; duration: number }) => void;
}

const PERF_WARNING_THRESHOLD = 10;

/** Stack of audio rows below the scene row. One row per clip — keeps it
 *  visually trivial to map "which bar is which clip." */
export default function TimelineAudioSection({
  clips,
  fps,
  currentFrame,
  totalFrames,
  onToggleClipEnabled,
  onClipContextMenu,
  selectedId,
  onSelectClip,
  height,
  trackWidth,
  onCommitClipTiming,
}: TimelineAudioSectionProps) {
  const totalSeconds = totalFrames / fps;
  const time = currentFrame / fps;
  const audibleSet = useMemo(
    () => new Set(activeClipsAt(clips, time).map((c) => c.id)),
    [clips, time],
  );
  const peakOverlap = useMemo(() => maxOverlap(clips), [clips]);
  const showPerfWarning = peakOverlap >= PERF_WARNING_THRESHOLD;

  if (clips.length === 0) return null;

  return (
    <div
      className="relative flex flex-col gap-1"
      style={height != null ? { height } : undefined}
      data-testid="timeline-audio-section"
    >
      {showPerfWarning && (
        <span
          data-testid="audio-perf-warning"
          title={`${peakOverlap} audio sources play at once at peak. Many overlapping audio sources can cause playback stutter on lower-end machines. Export uses ffmpeg amix with normalize=0 so per-clip volume is preserved.`}
          className="absolute right-1 top-0 z-10 cursor-help text-foreground/40"
        >
          ⚠️
        </span>
      )}
      {clips.map((clip) => (
        <div
          key={clip.id}
          className={`relative rounded bg-background/50 ${
            height != null ? "min-h-6 flex-1" : "h-6"
          }`}
        >
          <AudioClipRow
            clip={clip}
            totalSeconds={totalSeconds}
            trackWidth={trackWidth}
            audible={audibleSet.has(clip.id)}
            selected={selectedId === clip.id}
            onSelect={onSelectClip ? () => onSelectClip(clip.id) : undefined}
            onToggleEnabled={() => onToggleClipEnabled(clip.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              onClipContextMenu(clip.id, e.clientX, e.clientY);
            }}
            onCommitTiming={onCommitClipTiming}
          />
        </div>
      ))}
    </div>
  );
}

