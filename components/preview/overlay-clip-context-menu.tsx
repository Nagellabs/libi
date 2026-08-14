"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

interface OverlayClipContextMenuProps {
  overlayId: string;
  overlayKind: string;
  /** Overlay window — used to gate "Cut at playhead". */
  startTime: number;
  duration: number;
  /** Composition-global time at which the menu was opened. */
  playheadTime: number;
  x: number;
  y: number;
  onClose: () => void;
  onCut: () => void;
  onDuplicate: () => void;
  /** Remove the overlay from the manifest — non-destructive. The source file
   *  (image/video) stays in resources. Leaves the timeline gap behind. */
  onRemove: () => void;
  /** Remove the overlay AND close the hole it left: every overlay/audio clip
   *  starting at/after its end time shifts left by its duration. Items that
   *  start before that point (e.g. a full-length background) are left alone. */
  onRippleRemove: () => void;
  // ── Add-keyframe (keyframe DELETE / CLEAR live on the diamond's own menu) ──
  /** True when the playhead sits INSIDE this overlay's window — gates "Add
   *  keyframe" (a keyframe outside the window is meaningless). */
  playheadInWindow: boolean;
  /** True when the overlay has ≥1 keyframe — used in the remove-confirm copy. */
  hasKeyframes: boolean;
  /** Add a keyframe at the playhead (only meaningful when playheadInWindow). */
  onAddKeyframe: () => void;
}

/** mm:ss.f (tenths) — matches the timeline's readable timecode granularity. */
function formatClock(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}:${rem.toFixed(1).padStart(4, "0")}`;
}

/** Right-click menu for an overlay bar (image / video / text / code / three).
 *  Cut (split at the playhead), Duplicate, and Remove — the same three gestures
 *  the libi.split_clip / duplicate_clip / delete_clip MCP tools expose, sharing
 *  the lib/composition/clip-ops core via the /clips route. */
export default function OverlayClipContextMenu({
  overlayId,
  overlayKind,
  startTime,
  duration,
  playheadTime,
  x,
  y,
  onClose,
  onCut,
  onDuplicate,
  onRemove,
  onRippleRemove,
  playheadInWindow,
  hasKeyframes,
  onAddKeyframe,
}: OverlayClipContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  // Viewport-aware: flip ABOVE the click when there's no room below, and clamp
  // horizontally — so a right-click near the bottom of a scrolled timeline never
  // opens a menu that runs off-screen. useLayoutEffect (not useEffect) so the
  // flip happens BEFORE paint — otherwise the menu paints at the raw click point
  // first and visibly jumps, flickering the first item.
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

  // "Remove from timeline" destroys the WHOLE overlay — a two-step confirm so a
  // quick right-click meant for "Delete keyframe" can't nuke the layer by mistake.
  // Ripple delete additionally reshuffles every later clip's timing, so it gets
  // its own confirm copy warning about that.
  const [confirmingRemove, setConfirmingRemove] = useState<false | "plain" | "ripple">(false);

  const canCut = playheadTime > startTime && playheadTime < startTime + duration;

  return (
    <div
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-50 min-w-44 rounded-md border border-border bg-surface py-1 text-xs shadow-lg"
      role="menu"
      data-overlay-id={overlayId}
    >
      {confirmingRemove === "ripple" ? (
        <div className="px-3 py-2" data-testid="overlay-ripple-remove-confirm">
          <p className="mb-2 max-w-56 text-[11px] leading-snug text-muted-foreground">
            Remove the whole{" "}
            <span className="font-medium text-foreground">{overlayKind}</span> overlay AND close
            the gap it leaves — every clip starting after it shifts left to follow.
            {hasKeyframes ? " Its keyframes go with it." : ""} Clips already overlapping this one
            (e.g. a full-length background) are left in place. The source file stays in resources.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="overlay-ripple-remove-confirm-yes"
              onClick={() => { onRippleRemove(); onClose(); }}
              className="flex-1 cursor-pointer rounded bg-destructive/10 px-2 py-1 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/20"
            >
              Ripple delete
            </button>
            <button
              type="button"
              data-testid="overlay-ripple-remove-confirm-no"
              onClick={() => setConfirmingRemove(false)}
              className="flex-1 cursor-pointer rounded px-2 py-1 text-[11px] transition-colors hover:bg-surface-hover"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : confirmingRemove === "plain" ? (
        <div className="px-3 py-2" data-testid="overlay-remove-confirm">
          <p className="mb-2 max-w-56 text-[11px] leading-snug text-muted-foreground">
            Remove the whole{" "}
            <span className="font-medium text-foreground">{overlayKind}</span> overlay from the
            timeline?{hasKeyframes ? " Its keyframes go with it." : ""} To delete just a keyframe,
            use &ldquo;Delete keyframe&rdquo; instead. The source file stays in resources.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="overlay-remove-confirm-yes"
              onClick={() => { onRemove(); onClose(); }}
              className="flex-1 cursor-pointer rounded bg-destructive/10 px-2 py-1 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/20"
            >
              Remove overlay
            </button>
            <button
              type="button"
              data-testid="overlay-remove-confirm-no"
              onClick={() => setConfirmingRemove(false)}
              className="flex-1 cursor-pointer rounded px-2 py-1 text-[11px] transition-colors hover:bg-surface-hover"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <MenuItem
            onClick={() => { onCut(); onClose(); }}
            disabled={!canCut}
            title={canCut ? `Cut at ${playheadTime.toFixed(2)}s` : "Move the playhead over this clip to cut it"}
          >
            Cut at playhead
          </MenuItem>
          <MenuItem onClick={() => { onDuplicate(); onClose(); }}>
            Duplicate
          </MenuItem>
          <MenuItem
            danger
            onClick={() => setConfirmingRemove("plain")}
            title={`Take this ${overlayKind} overlay out of the composition (asks to confirm first). The source file stays in resources. Leaves the timeline gap behind.`}
          >
            Remove from timeline…
          </MenuItem>
          <MenuItem
            danger
            onClick={() => setConfirmingRemove("ripple")}
            title={`Take this ${overlayKind} overlay out of the composition AND shift every later clip left to close the gap (asks to confirm first). The source file stays in resources.`}
          >
            Ripple delete (close gap)…
          </MenuItem>

          <div className="my-1 border-t border-border/40" />

          <MenuItem
            onClick={() => { onAddKeyframe(); onClose(); }}
            disabled={!playheadInWindow}
            title={
              playheadInWindow
                ? `Snapshot this layer's position/scale/rotation/opacity at ${formatClock(playheadTime - startTime)} into the clip`
                : "Move the playhead over this overlay to add a keyframe"
            }
          >
            {playheadInWindow
              ? `Add keyframe at ${formatClock(playheadTime - startTime)}`
              : "Add keyframe"}
          </MenuItem>
        </>
      )}
    </div>
  );
}

function MenuItem({
  children, onClick, disabled, title, danger,
}: { children: React.ReactNode; onClick: () => void; disabled?: boolean; title?: string; danger?: boolean }) {
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
