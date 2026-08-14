"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioClip } from "@/lib/engine/types";
import { Waveform } from "./waveform";
import { useAudioClipPosition } from "@/hooks/preview/use-audio-clip-position";
import { dragToTiming } from "@/lib/preview/audio-clip-drag";

interface AudioClipRowProps {
  clip: AudioClip;
  /** Total composition duration in seconds — used to size the bar. */
  totalSeconds: number;
  /** Content lane width in px (to convert a pointer drag into seconds). */
  trackWidth?: number;
  /** Is the clip currently audible at the playhead? Adds a glow. */
  audible: boolean;
  /** Is this clip the current inspector selection? Adds a selected ring. */
  selected?: boolean;
  onToggleEnabled: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  /** Click the bar (not the mute button) to select it in the inspector. */
  onSelect?: () => void;
  /** Commit a new [startTime,duration] after a horizontal drag. */
  onCommitTiming?: (clipId: string, timing: { startTime: number; duration: number }) => void;
}

/** A single bar on an audio row. Displays as a colored rectangle scaled
 *  to its startTime + duration. Speaker icon toggles the enabled flag;
 *  clicking the bar selects the clip for the inspector. */
export default function AudioClipRow({
  clip,
  totalSeconds,
  trackWidth = 0,
  audible,
  selected,
  onToggleEnabled,
  onContextMenu,
  onSelect,
  onCommitTiming,
}: AudioClipRowProps) {
  // Optimistic-hold position: the committed value is HELD through the server
  // round-trip until the incoming clip prop reflects it, so a horizontal drag
  // never flashes back to the stale persisted start on release (the same
  // data-gated reconcile the overlay-edit store uses for video bars).
  const { display, hold } = useAudioClipPosition({
    startTime: clip.startTime,
    duration: clip.duration,
  });
  // Live local drag offset (seconds) while actively dragging this clip.
  const [dragSec, setDragSec] = useState<number | null>(null);
  // Latest base values for the mousedown closure. Written in an effect (never
  // during render); mousedown only fires post-commit, so it always sees the
  // committed values.
  const baseRef = useRef({ start: display.startTime, duration: display.duration });
  useEffect(() => {
    baseRef.current = { start: display.startTime, duration: display.duration };
  });

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      // Left button only — a right-click opens the context menu and must not
      // drag or seek (the stray seek flickered the menu's "Split here" item).
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const downX = e.clientX;
      const start0 = baseRef.current.start;
      const dur0 = baseRef.current.duration;
      const pxPerSec = totalSeconds > 0 && trackWidth > 0 ? trackWidth / totalSeconds : 0;
      let moved = false;
      let dsec = 0;
      const move = (ev: MouseEvent) => {
        if (Math.abs(ev.clientX - downX) > 3) moved = true;
        const next = dragToTiming({ startTime: start0, duration: dur0 }, ev.clientX - downX, pxPerSec);
        dsec = next.startTime - start0;
        if (moved) setDragSec(dsec);
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        setDragSec(null);
        if (!moved) {
          onSelect?.();
          return;
        }
        const committed = { startTime: start0 + dsec, duration: dur0 };
        hold(committed); // hold the dragged position until the prop catches up
        onCommitTiming?.(clip.id, committed);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [clip.id, totalSeconds, trackWidth, onSelect, onCommitTiming, hold],
  );

  const startSec = display.startTime + (dragSec ?? 0);
  const leftPct = totalSeconds > 0 ? (startSec / totalSeconds) * 100 : 0;
  const widthPct = totalSeconds > 0 ? (display.duration / totalSeconds) * 100 : 0;

  // Free clips: inline (blue) vs standalone (emerald). Detached audio is no longer
  // rendered here — it's an independent DetachedAudioTrack row.
  const baseColor = clip.kind === "inline" ? "bg-blue-500/30" : "bg-emerald-500/30";
  const enabledColor = clip.enabled ? baseColor : "bg-foreground/10";
  // Selection wins the ring; otherwise an audible clip glows.
  const ring = selected
    ? "ring-2 ring-primary ring-offset-1 ring-offset-background"
    : audible && clip.enabled
      ? "ring-2 ring-primary/50"
      : "";
  const displayLabel = clip.label ?? (clip.kind === "inline" ? "🔗 audio" : "audio");

  return (
    <div
      data-testid="audio-clip-bar"
      data-clip-id={clip.id}
      data-audible={audible ? "true" : "false"}
      data-selected={selected ? "true" : undefined}
      onContextMenu={onContextMenu}
      onMouseDown={startDrag}
      className={`absolute inset-y-0 flex cursor-grab items-center gap-1 overflow-hidden rounded border border-border/60 px-1.5 ${enabledColor} ${ring} transition-shadow`}
      style={{
        left: `${leftPct}%`,
        width: `${widthPct}%`,
        transition: dragSec != null ? "none" : undefined,
      }}
      title={`${displayLabel} — click to inspect, right-click for options`}
    >
      {/* Waveform fills the bar behind the controls (enhances the solid color;
          falls back to nothing if the file can't be decoded). */}
      <div className="pointer-events-none absolute inset-0 opacity-70">
        <Waveform
          fileId={clip.fileId}
          trimStart={clip.trimStart}
          duration={clip.duration}
          color={clip.enabled ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.25)"}
        />
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onToggleEnabled(); }}
        aria-label={clip.enabled ? "Mute clip" : "Unmute clip"}
        className="relative z-10 flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center text-foreground/80"
      >
        {clip.enabled ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden>
            <path d="M2 4h1l2-2v6L3 6H2V4z" />
            <path d="M7 3a2 2 0 0 1 0 4V3z" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden>
            <path d="M2 4h1l2-2v6L3 6H2V4z" />
            <line x1="6" y1="2" x2="9" y2="8" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>
      <span className="relative z-10 truncate text-[10px] text-foreground/70">
        {displayLabel}
      </span>
      {clip.duck && (
        <span title={`Ducked by ${clip.duck.sidechainClipId}`} className="text-[10px] text-foreground/60">
          🔉
        </span>
      )}
    </div>
  );
}
