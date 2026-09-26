"use client";

import { useState } from "react";
import { catalogDayKey, utcDay } from "@/lib/templates/details";

/** 30 days of uses (UTC days, today last) as one polyline; no axes, it sits in a table cell. */
export function UsesSparkline({ byDay, days = 30, now: nowProp }: { byDay: Record<string, number>; days?: number; now?: number }) {
  // "Today" is fixed when the cell mounts; the table re-reads /mine every 10 minutes anyway.
  const [mountedAt] = useState(() => Date.now());
  const now = nowProp ?? mountedAt;
  // `/mine` may key a day either way: one normaliser (lib/templates/details.ts).
  const counts = new Map(Object.entries(byDay).flatMap(([k, v]) => {
    const day = catalogDayKey(k);
    return day ? [[day, v] as const] : [];
  }));
  const values = Array.from({ length: days }, (_, i) => counts.get(utcDay(now - (days - 1 - i) * 86_400_000)) ?? 0);
  const max = Math.max(1, ...values);
  const points = values.map((v, i) => `${(i / (days - 1)) * 100},${19 - (v / max) * 18}`).join(" ");
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <svg
      data-testid="uses-sparkline"
      role="img"
      viewBox="0 0 100 20"
      className="h-5 w-24 text-muted-foreground"
      preserveAspectRatio="none"
      aria-label={`${total} ${total === 1 ? "use" : "uses"} in the last ${days} days`}
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
