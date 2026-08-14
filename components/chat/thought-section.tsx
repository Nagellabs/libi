"use client";

import { useState } from "react";

interface ThoughtSectionProps {
  text: string;
  /** True when the thought is still being produced (no subsequent content yet) */
  active: boolean;
}

export default function ThoughtSection({ text, active }: ThoughtSectionProps) {
  const [userToggled, setUserToggled] = useState(false);
  const [userExpanded, setUserExpanded] = useState(true);

  const expanded = userToggled ? userExpanded : active;

  const handleToggle = () => {
    setUserToggled(true);
    setUserExpanded((prev) => !prev);
  };

  return (
    <div className="mt-1">
      <button
        onClick={handleToggle}
        className="flex items-center gap-2 text-sm text-muted-foreground/70 hover:text-muted-foreground transition-colors cursor-pointer py-1"
      >
        <span className="text-xs">{expanded ? "▾" : "▸"}</span>
        <span className="italic">thinking</span>
        {active && (
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-muted-foreground/50" />
        )}
      </button>
      <div
        className="overflow-hidden transition-all duration-200"
        style={{
          maxHeight: expanded ? "500px" : "0px",
          opacity: expanded ? 1 : 0,
        }}
      >
        <p className="mt-1 text-sm leading-relaxed italic text-muted-foreground whitespace-pre-wrap">
          {text}
        </p>
      </div>
    </div>
  );
}
