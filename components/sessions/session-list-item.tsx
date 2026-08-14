"use client";

import { getSessionIcon } from "@/lib/sessions/session-icons";
import { formatSessionDate } from "./session-list-utils";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

interface SessionListItemProps {
  sessionId: string;
  title: string | null;
  updatedAt: string | null;
  active: boolean;
  isSelected: boolean;
  collapsed: boolean;
  onClick: () => void;
}

export default function SessionListItem({
  sessionId,
  title,
  updatedAt,
  active,
  isSelected,
  collapsed,
  onClick,
}: SessionListItemProps) {
  const icon = getSessionIcon(sessionId);
  const displayTitle = title || "New chat";

  const iconElement = (
    <div className="relative shrink-0">
      <svg
        viewBox="0 0 24 24"
        className={`h-5 w-5 transition-opacity ${isSelected ? "opacity-100" : "opacity-60 group-hover:opacity-90"}`}
        fill={icon.color}
      >
        {(Array.isArray(icon.d) ? icon.d : [icon.d]).map((p, i) => (
          <path key={i} d={p} />
        ))}
      </svg>
      {/* Green dot for active connection */}
      {active && (
        <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-emerald-500 ring-1 ring-background" />
      )}
    </div>
  );

  const buttonClassName = `cursor-pointer group relative flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-all duration-150 ${
    isSelected
      ? "bg-background shadow-sm"
      : "hover:bg-accent/50"
  } ${collapsed ? "justify-center" : ""}`;

  const buttonInner = (
    <>
      {/* Active indicator bar */}
      {isSelected && (
        <div className="absolute -left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
      )}

      {iconElement}

      {!collapsed && (
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-foreground">{displayTitle}</div>
          {updatedAt && (
            <div className="text-[11px] text-muted-foreground">
              {formatSessionDate(updatedAt)}
            </div>
          )}
        </div>
      )}
    </>
  );

  return (
    <Tooltip>
      <TooltipTrigger
        className={buttonClassName}
        onClick={onClick}
      >
        {buttonInner}
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={8} className="max-w-[240px]">
        {displayTitle}
      </TooltipContent>
    </Tooltip>
  );
}
