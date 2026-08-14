"use client";

interface MasterVolumeControlProps {
  volume: number;
  muted: boolean;
  onVolumeChange: (v: number) => void;
  onToggleMuted: () => void;
}

/** Speaker icon + always-visible horizontal slider in the preview controls
 *  bar. Click the icon to toggle mute. Drag the slider to adjust master
 *  volume; both UI changes propagate through to every audio source. */
export default function MasterVolumeControl({
  volume,
  muted,
  onVolumeChange,
  onToggleMuted,
}: MasterVolumeControlProps) {
  const displayVolume = muted ? 0 : volume;
  return (
    <div className="flex items-center gap-2" data-testid="master-volume">
      <button
        onClick={onToggleMuted}
        aria-label={muted ? "Unmute" : "Mute"}
        title={muted ? "Unmute (M)" : "Mute (M)"}
        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-foreground transition-colors hover:bg-surface-hover"
      >
        {muted || displayVolume === 0 ? (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M11.5 4.5L13 6L14.5 4.5L15.5 5.5L14 7L15.5 8.5L14.5 9.5L13 8L11.5 9.5L10.5 8.5L12 7L10.5 5.5L11.5 4.5Z" />
            <path d="M3 6h2l3-3v10L5 10H3V6z" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M3 6h2l3-3v10L5 10H3V6z" />
            <path d="M11 5a3 3 0 0 1 0 6V5z" />
            {displayVolume > 0.5 && <path d="M13 3a6 6 0 0 1 0 10V3z" />}
          </svg>
        )}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={displayVolume}
        onChange={(e) => onVolumeChange(Number(e.target.value))}
        aria-label="Master volume"
        className="h-1 w-20 cursor-pointer accent-primary"
      />
    </div>
  );
}
