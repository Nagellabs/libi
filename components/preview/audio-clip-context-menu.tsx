"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AudioClip } from "@/lib/engine/types";

interface AudioClipContextMenuProps {
  clip: AudioClip;
  /** Composition-global time at which the menu was opened — used for "Split here". */
  playheadTime: number;
  x: number;
  y: number;
  onClose: () => void;
  onToggleEnabled: () => void;
  onSplit: () => void;
  onDuplicate: () => void;
  onUnlink: () => void;
  /** Remove the clip from the manifest — non-destructive. Source file
   *  stays in resources; destructive file deletion lives in that panel. */
  onRemove: () => void;
  onDuckOpen: () => void;
  onDuckDisable: () => void;
}

export default function AudioClipContextMenu({
  clip,
  playheadTime,
  x,
  y,
  onClose,
  onToggleEnabled,
  onSplit,
  onDuplicate,
  onUnlink,
  onRemove,
  onDuckOpen,
  onDuckDisable,
}: AudioClipContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  // useLayoutEffect so the viewport flip lands BEFORE paint (no first-item flicker).
  useLayoutEffect(() => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const top = y + r.height > window.innerHeight - 8 ? y - r.height : y;
    const left = Math.min(x, window.innerWidth - r.width - 8);
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y]);
  useEffect(() => {
    const handleClickAway = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", handleClickAway);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClickAway);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [onClose]);

  const canSplit = playheadTime > clip.startTime && playheadTime < clip.startTime + clip.duration;
  const isLinked = clip.kind === "inline";

  return (
    <div
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-50 min-w-44 rounded-md border border-border bg-surface py-1 text-xs shadow-lg"
      role="menu"
    >
      <MenuItem onClick={() => { onToggleEnabled(); onClose(); }}>
        {clip.enabled ? "Mute clip" : "Unmute clip"}
      </MenuItem>
      <MenuItem
        onClick={() => { onSplit(); onClose(); }}
        disabled={!canSplit}
        title={canSplit ? `Split at ${playheadTime.toFixed(2)}s` : "Move the playhead inside the clip to split"}
      >
        Split here
      </MenuItem>
      <MenuItem
        onClick={() => { onDuplicate(); onClose(); }}
        title="Add a free-standing copy of this clip right after it."
      >
        Duplicate
      </MenuItem>
      {isLinked && (
        <MenuItem onClick={() => { onUnlink(); onClose(); }}>
          Unlink from scene
        </MenuItem>
      )}
      <div className="my-1 border-t border-border/40" />
      {clip.duck ? (
        <MenuItem onClick={() => { onDuckDisable(); onClose(); }}>
          Disable ducking
        </MenuItem>
      ) : (
        <MenuItem onClick={() => { onDuckOpen(); onClose(); }}>
          Apply ducking…
        </MenuItem>
      )}
      <div className="my-1 border-t border-border/40" />
      <MenuItem
        onClick={() => {
          if (isLinked) {
            const ok = window.confirm(
              "Remove this audio from the timeline? The scene will play silently. The source file stays in resources — right-click the scene later to re-add.",
            );
            if (!ok) return;
          }
          onRemove();
          onClose();
        }}
        title="Take this clip out of the composition. The source file stays in resources."
      >
        Remove from timeline
      </MenuItem>
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  disabled,
  title,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex w-full cursor-pointer items-center justify-between px-3 py-1.5 text-left transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40 ${className ?? ""}`}
    >
      {children}
    </button>
  );
}
