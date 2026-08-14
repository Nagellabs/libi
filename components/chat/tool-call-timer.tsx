"use client";

import { useEffect, useState } from "react";

interface ToolCallTimerProps {
  /** Epoch ms when the tool was observed to START executing. */
  runningAt: number;
  /** Epoch ms when the tool completed. When set, the timer is static. */
  completedAt?: number;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/** Elapsed-time display derived PURELY from part fields — no local start
 *  capture, so it renders identically after refresh/re-mount. Ticks only
 *  while the tool is still running. */
export default function ToolCallTimer({ runningAt, completedAt }: ToolCallTimerProps) {
  // The current time is STATE (updated by the interval), not a Date.now()
  // call during render — render stays pure, and the display still updates
  // once a second while the tool is running.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (completedAt !== undefined) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [completedAt]);

  const elapsed = (completedAt ?? now) - runningAt;
  return <span className="text-muted-foreground/70">({formatElapsed(elapsed)})</span>;
}
