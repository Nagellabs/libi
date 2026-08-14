"use client";

import type { LucideIcon } from "lucide-react";

/** Fixed rail width (px). Every row + the ruler reserve exactly this on the
 *  left, so a given second maps to the same x across all rows. */
export const RAIL_WIDTH = 28;

interface TrackRailProps {
  icon: LucideIcon;
  /** Short label — used for the test id / aria. */
  label: string;
  /** Rich hover tooltip ("<type> — <full name>" + attached status), shown on the
   *  ICON so the full (untruncated) name is readable even though the bar label is
   *  capped. Falls back to `label`. */
  tooltip?: string;
  /** Optional click (e.g. collapse a row). When set, renders a caret hint. */
  onClick?: () => void;
  /** Caret direction when clickable; omitted = no caret. */
  collapsed?: boolean;
}

export function TrackRail({ icon: Icon, label, tooltip, onClick, collapsed }: TrackRailProps) {
  const title = tooltip ?? label;
  const content = (
    <>
      <Icon className="size-3.5" aria-hidden />
      {onClick && (
        <span className="text-[8px] leading-none opacity-50" aria-hidden>
          {collapsed ? "▸" : "▾"}
        </span>
      )}
      {/* Custom hover tooltip (native `title` was too slow/easy to miss). Shows
          the full "<type> — <name>" to the RIGHT of the icon so the narrow rail
          never clips it. */}
      <span
        data-testid="track-rail-tooltip"
        className="pointer-events-none absolute left-full top-1/2 z-50 ml-1 -translate-y-1/2 whitespace-nowrap rounded border border-border bg-popover px-1.5 py-0.5 text-[10px] text-foreground opacity-0 shadow-md transition-opacity duration-100 group-hover:opacity-100"
      >
        {title}
      </span>
    </>
  );
  // Sticky-left so the rail stays pinned at x=0 while the lane content scrolls
  // horizontally under it inside the timeline's single scroll container.
  const railStyle = { width: RAIL_WIDTH, position: "sticky" as const, left: 0 };
  const className =
    "group relative z-30 flex shrink-0 flex-col items-center justify-center gap-0.5 bg-surface text-muted-foreground";
  if (onClick) {
    return (
      <button
        type="button"
        data-testid={`track-rail-${label}`}
        title={title}
        onClick={onClick}
        style={railStyle}
        className={`${className} cursor-pointer hover:text-foreground`}
      >
        {content}
      </button>
    );
  }
  return (
    <div
      data-testid={`track-rail-${label}`}
      title={title}
      style={railStyle}
      className={className}
    >
      {content}
    </div>
  );
}
