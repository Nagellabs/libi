/** Pure display formatting for the context-usage chip + budget popover. */

/** 950 → "950", 82000 → "82k", 1500000 → "1.5m". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  const m = n / 1_000_000;
  const rounded = Math.round(m * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded}m`;
}

/** Epoch-seconds reset → "6:00 PM" (same local day) or "Tue" (later day). */
export function formatReset(resetsAt: number, now: number = Date.now()): string {
  const reset = new Date(resetsAt * 1000);
  const ref = new Date(now);
  const sameDay =
    reset.getFullYear() === ref.getFullYear() &&
    reset.getMonth() === ref.getMonth() &&
    reset.getDate() === ref.getDate();
  if (sameDay) {
    return reset.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return reset.toLocaleDateString("en-US", { weekday: "short" });
}

/** Chip color severity from used/size fraction. */
export function usageSeverity(pct: number): "ok" | "warn" | "critical" {
  if (pct >= 0.95) return "critical";
  if (pct >= 0.8) return "warn";
  return "ok";
}

// Plan-window row labels moved into components/chat/context-usage-chip.tsx
// (PLAN_ROWS) when the popover switched from event-based rate-limit
// snapshots to the authoritative claude.ai plan-usage endpoint
// (lib/claude/plan-usage.ts).
