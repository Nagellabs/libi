// components/preview/keyframe-list.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { Diamond, Trash2 } from "lucide-react";
import type { Overlay } from "@/lib/engine/types";
import { overlayKeyframeTimes } from "@/lib/overlays/keyframes";
import { keyframeRows, type KeyframeRow } from "@/lib/preview/keyframe-list";
import { frameToTimecode } from "@/lib/preview/timecode";
import { useKeyframeOps } from "@/lib/queries/keyframes";

interface KeyframeListProps {
  pieceId: string;
  overlay: Overlay;
  fps: number;
  /** The selected keyframe's normalized time, or null. */
  selectedT: number | null;
  onSelect: (t: number) => void;
  /** Add a keyframe at the live playhead (+ select it). */
  onAddKeyframeAtPlayhead: () => void;
  readOnly: boolean;
}

/** The CapCut-style "◇ Key at playhead" button — the primary add affordance. */
export function AddKeyframeButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="add-keyframe-at-playhead"
      onClick={onClick}
      title="Add a keyframe for this layer at the current playhead position"
      className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded border border-border bg-surface px-2 py-0.5 text-[11px] text-foreground transition-colors hover:bg-surface-hover"
    >
      <Diamond className="size-2.5 fill-primary text-primary" /> Key at playhead
    </button>
  );
}

/**
 * The left column of the Keyframes tab: one clickable row per keyframe. Each row
 * shows a diamond, its 1-based index, the HH:MM:SS:FF timecode, and the outgoing
 * easing label (last row = "— end —"). Clicking a row selects that keyframe;
 * the delete button removes it and re-selects a neighbor.
 */
export function KeyframeList({
  pieceId,
  overlay,
  fps,
  selectedT,
  onSelect,
  onAddKeyframeAtPlayhead,
  readOnly,
}: KeyframeListProps) {
  const { remove } = useKeyframeOps(pieceId);
  const rows = keyframeRows(overlay, fps);
  const duration = overlay.duration > 0 ? overlay.duration : 1;

  const onDelete = (row: KeyframeRow) => {
    // Re-select a neighbor BEFORE the composition refetches, so the right pane
    // never points at the deleted keyframe. Nearest lower, else nearest higher,
    // else null.
    if (row.t === selectedT) {
      const remaining = overlayKeyframeTimes(overlay).filter((t) => t !== row.t);
      const lower = remaining.filter((t) => t < row.t);
      const higher = remaining.filter((t) => t > row.t);
      const next =
        lower.length > 0
          ? lower[lower.length - 1]
          : higher.length > 0
            ? higher[0]
            : null;
      if (next !== null) onSelect(next);
    }
    remove.mutate({ overlayId: overlay.id, time: row.t * duration });
  };

  return (
    <div className="flex min-h-0 flex-col gap-1.5" data-testid="keyframe-list">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-foreground">
          Keyframes <span className="text-muted-foreground">{rows.length}</span>
        </span>
        {!readOnly && <AddKeyframeButton onClick={onAddKeyframeAtPlayhead} />}
      </div>
      <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
        {rows.map((row, i) => {
          const isSelected = row.t === selectedT;
          return (
            <div
              key={row.t}
              data-testid="keyframe-row"
              data-t={row.t}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(row.t)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(row.t);
                }
              }}
              className={`group flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[11px] transition-colors ${
                isSelected
                  ? "bg-primary/15 ring-1 ring-inset ring-primary"
                  : "hover:bg-surface-hover"
              }`}
            >
              <Diamond
                className={`size-3 shrink-0 ${
                  isSelected ? "fill-primary text-primary" : "fill-muted-foreground text-muted-foreground"
                }`}
              />
              <span className="w-4 shrink-0 tabular-nums text-muted-foreground">{i + 1}</span>
              <AnimatedTimecode frame={row.frame} fps={fps} rowKey={row.t} />
              <span className="ml-auto truncate text-muted-foreground">
                {row.isLast ? row.easingLabel : `→ ${row.easingLabel}`}
              </span>
              {!readOnly && (
                <button
                  type="button"
                  data-testid="keyframe-row-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(row);
                  }}
                  className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground opacity-60 transition-opacity hover:text-foreground group-hover:opacity-100"
                  aria-label="Delete keyframe"
                >
                  <Trash2 className="size-[13px]" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Renders the HH:MM:SS:FF timecode, counting the frame up from 0 to `frame` over
 * ~280ms on FIRST mount for this row (keyed on `rowKey`). Respects
 * `prefers-reduced-motion` — renders the final value immediately when reduced.
 * Monospace so the width never jitters mid-count.
 */
function AnimatedTimecode({ frame, fps, rowKey }: { frame: number; fps: number; rowKey: number }) {
  const [display, setDisplay] = useState(frame);
  // Track the row identity so we animate once per row, not on every re-render.
  const animatedFor = useRef<number | null>(null);

  // Keep the display in sync the moment the row identity or its frame changes
  // (previous-state pattern, pre-paint). The count-up animation below then
  // overrides it frame-by-frame when this row hasn't animated yet.
  const [prevIdentity, setPrevIdentity] = useState({ rowKey, frame });
  if (prevIdentity.rowKey !== rowKey || prevIdentity.frame !== frame) {
    setPrevIdentity({ rowKey, frame });
    setDisplay(frame);
  }

  useEffect(() => {
    // Animate only the FIRST time we see this row identity. If the frame later
    // changes for the SAME row (e.g. the overlay's duration was edited), the
    // render-time sync above already updated the display — skip the count-up.
    const alreadyAnimated = animatedFor.current === rowKey;
    animatedFor.current = rowKey;

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (alreadyAnimated || reduced || frame <= 0) return;

    const DURATION_MS = 280;
    let raf = 0;
    let start = 0;
    const step = (now: number) => {
      if (!start) start = now;
      const p = Math.min(1, (now - start) / DURATION_MS);
      setDisplay(Math.round(frame * p));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [rowKey, frame]);

  return <span className="shrink-0 font-mono text-foreground">{frameToTimecode(display, fps)}</span>;
}
