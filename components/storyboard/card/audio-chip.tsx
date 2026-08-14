"use client";

import { useRef, useState } from "react";
import { PauseIcon, PlayIcon, XIcon } from "lucide-react";

interface AudioChipProps {
  src?: string;
  label: string;
  duration?: string;
  inherited?: boolean;
  badge?: string;
  /** Click the chip body to open the large viewer. */
  onView?: () => void;
  onRemove?: () => void;
}

/** Decorative waveform bars — static, varied heights for a visual indicator. */
const BAR_HEIGHTS = [5, 8, 12, 7, 14, 9, 11, 6, 10];

/** Horizontal audio reference chip with an inline play/pause toggle.
 *  Purely presentational — driven entirely by props. */
export function AudioChip({
  src,
  label,
  duration,
  inherited,
  badge,
  onView,
  onRemove,
}: AudioChipProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);

  function togglePlay() {
    if (!src || !audioRef.current) return;
    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
    } else {
      audioRef.current.play().catch(() => {});
      setPlaying(true);
    }
  }

  const waveColor = inherited ? "bg-purple-400/70" : "bg-muted-foreground/50";

  const borderClasses = inherited
    ? "ring-2 ring-purple-400 animate-pulse border-purple-400/40"
    : "border-border";

  const metaLine = [badge, duration].filter(Boolean).join(" · ");

  return (
    <div
      className={[
        "flex items-center gap-2 w-[180px] px-2 py-1.5 rounded-md border bg-muted/40",
        borderClasses,
      ].join(" ")}
    >
      {/* Hidden audio element */}
      {src && (
        <audio
          ref={audioRef}
          src={src}
          onEnded={() => setPlaying(false)}
        />
      )}

      {/* Play/pause button */}
      <button
        type="button"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          togglePlay();
        }}
        disabled={!src}
        className={[
          "shrink-0 size-6 rounded-full flex items-center justify-center transition-colors",
          src
            ? "cursor-pointer bg-blue-600 text-white hover:bg-blue-700"
            : "bg-muted text-muted-foreground/40 cursor-not-allowed",
        ].join(" ")}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? (
          <PauseIcon className="size-3" />
        ) : (
          <PlayIcon className="size-3" />
        )}
      </button>

      {/* Mini waveform */}
      <div className="flex items-end gap-[2px] h-4 shrink-0">
        {BAR_HEIGHTS.map((h, i) => (
          <span
            key={i}
            className={["rounded-sm w-[2px]", waveColor].join(" ")}
            style={{ height: h }}
          />
        ))}
      </div>

      {/* Label block — click to open the viewer */}
      <button
        type="button"
        onClick={onView}
        disabled={!onView}
        className={["flex-1 min-w-0 flex flex-col text-left", onView ? "cursor-pointer" : ""].join(" ")}
      >
        <span className="text-[10px] font-medium text-foreground/90 truncate leading-tight">
          {label}
        </span>
        {metaLine && (
          <span className="text-[9px] text-muted-foreground truncate leading-tight">
            {metaLine}
          </span>
        )}
      </button>

      {/* Remove (clear the param) */}
      {onRemove && (
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="cursor-pointer shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-red-400"
          aria-label="Remove audio"
        >
          <XIcon className="size-3" />
        </button>
      )}
    </div>
  );
}
