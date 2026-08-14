"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

interface SceneContextMenuProps {
  sceneId: string;
  sceneName: string;
  /** True when this scene's source has audio AND it currently has no
   *  linked AudioClip — controls whether "Re-add audio" is shown. */
  /** Scene window (composition-global) — gates "Cut at playhead". */
  sceneStart: number;
  sceneDuration: number;
  /** Composition-global time at which the menu was opened. */
  playheadTime: number;
  x: number;
  y: number;
  onClose: () => void;
  onCut: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

export default function SceneContextMenu({
  sceneId,
  sceneName,
  sceneStart,
  sceneDuration,
  playheadTime,
  x,
  y,
  onClose,
  onCut,
  onDuplicate,
  onRemove,
}: SceneContextMenuProps) {
  const canCut = playheadTime > sceneStart && playheadTime < sceneStart + sceneDuration;
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
    const onAway = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onAway);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onAway);
      document.removeEventListener("keydown", onEsc);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-50 min-w-48 rounded-md border border-border bg-surface py-1 text-xs shadow-lg"
      role="menu"
      data-scene-id={sceneId}
    >
      <MenuItem
        onClick={() => { onCut(); onClose(); }}
        disabled={!canCut}
        title={canCut ? `Cut at ${playheadTime.toFixed(2)}s` : "Move the playhead over this scene to cut it"}
      >
        Cut at playhead
      </MenuItem>
      <MenuItem
        onClick={() => { onDuplicate(); onClose(); }}
        title="Insert a copy of this scene right after it."
      >
        Duplicate
      </MenuItem>
      <MenuItem
        onClick={() => {
          const ok = window.confirm(
            `Remove "${sceneName}" from the timeline? The source file stays in resources — you can add it back later. Linked audio for this scene will also be removed.`,
          );
          if (!ok) return;
          onRemove();
          onClose();
        }}
        title="Take this scene out of the composition. The source file stays in resources."
      >
        Remove from timeline
      </MenuItem>
    </div>
  );
}

function MenuItem({
  children, onClick, disabled, title,
}: { children: React.ReactNode; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 text-left transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
