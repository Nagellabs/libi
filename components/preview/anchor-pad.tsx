"use client";

import type { CaptionAnchor } from "@/lib/captions/types";

/** The 9 numpad anchors, row-major top→bottom (top-left … bottom-right). */
const ANCHORS: CaptionAnchor[] = [
  "top-left", "top-center", "top-right",
  "mid-left", "mid-center", "mid-right",
  "bottom-left", "bottom-center", "bottom-right",
];

/**
 * AnchorPad — a pure, presentational 3×3 anchor picker. Renders nine cells; the
 * active `anchor` is highlighted (and `aria-pressed`), and clicking a cell calls
 * `onAnchorChange(a)` with that anchor. Shared by the text-caption inspector and
 * (later) the Transform tab of other overlay kinds.
 *
 * Stateless by design: the parent owns the commit (discrete edit / flush). This
 * component just renders the grid and reports clicks.
 */
export function AnchorPad({
  anchor,
  onAnchorChange,
  className,
}: {
  anchor: CaptionAnchor;
  onAnchorChange: (a: CaptionAnchor) => void;
  className?: string;
}) {
  return (
    <div
      data-testid="anchor-pad"
      className={`grid w-fit grid-cols-3 gap-1${className ? ` ${className}` : ""}`}
    >
      {ANCHORS.map((a) => (
        <button
          key={a}
          type="button"
          data-testid={`anchor-cell-${a}`}
          onClick={() => onAnchorChange(a)}
          aria-pressed={anchor === a}
          className={`size-6 cursor-pointer rounded border text-[9px] ${
            anchor === a
              ? "border-primary bg-primary/20 text-foreground"
              : "border-border text-muted-foreground hover:text-foreground"
          }`}
          title={a}
        >
          •
        </button>
      ))}
    </div>
  );
}
