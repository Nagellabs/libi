"use client";

import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The small square chat/resources toggle button rendered in editor-panel
 * headers. Extracted so the "No piece open" empty state can render the exact
 * same toggles as the piece-mode header.
 */
export function HeaderToggleButton({
  icon: Icon,
  active,
  title,
  onClick,
}: {
  icon: LucideIcon;
  active: boolean;
  title: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "cursor-pointer flex size-7 items-center justify-center rounded-md transition-colors",
        active
          ? "text-muted-foreground hover:bg-surface-hover hover:text-foreground"
          : "bg-muted border border-border text-foreground hover:bg-surface-hover",
      )}
      aria-pressed={active}
    >
      <Icon className="size-3.5" strokeWidth={1.8} />
    </button>
  );
}
