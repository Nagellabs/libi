"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

interface KeyframeContextMenuProps {
  /** Header label, e.g. "Keyframe @ 00:00:09". */
  label: string;
  /** How many keyframes the overlay has — gates "Clear all" (only shown for ≥2). */
  keyframeCount: number;
  x: number;
  y: number;
  onClose: () => void;
  /** Select this keyframe + open the Keyframes tab to shape its curve. */
  onEditEasing: () => void;
  /** Delete THIS keyframe. */
  onDelete: () => void;
  /** Remove every keyframe on the overlay. */
  onClearAll: () => void;
}

/**
 * Right-click menu for a single keyframe DIAMOND — the keyframe-scoped ops
 * (edit easing / delete this keyframe / clear all), kept OFF the clip bar menu
 * so a delete-keyframe can never be confused with removing the whole overlay.
 * Positioning mirrors `overlay-clip-context-menu.tsx` (viewport-flip + clamp,
 * click-away + Esc to close).
 */
export default function KeyframeContextMenu({
  label,
  keyframeCount,
  x,
  y,
  onClose,
  onEditEasing,
  onDelete,
  onClearAll,
}: KeyframeContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
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
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
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
      className="fixed z-50 min-w-44 rounded-md border border-border bg-surface py-1 text-xs shadow-lg"
      role="menu"
      data-testid="keyframe-context-menu"
    >
      <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <MenuItem
        onClick={() => {
          onEditEasing();
          onClose();
        }}
        title="Select this keyframe and open the Keyframes tab to shape its easing curve"
      >
        Edit easing…
      </MenuItem>
      <MenuItem
        danger
        onClick={() => {
          onDelete();
          onClose();
        }}
        title="Delete just this keyframe"
      >
        Delete keyframe
      </MenuItem>
      {keyframeCount > 1 && (
        <MenuItem
          danger
          onClick={() => {
            onClearAll();
            onClose();
          }}
          title="Remove every keyframe — this layer stops animating"
        >
          Clear all keyframes
        </MenuItem>
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  disabled,
  title,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex w-full cursor-pointer items-center justify-between px-3 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        danger ? "text-destructive hover:bg-destructive/10" : "hover:bg-surface-hover"
      }`}
    >
      {children}
    </button>
  );
}
