"use client";

import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { trackEvent } from "@/lib/analytics/client";
import { useSessionContext } from "@/lib/queries/session-context";
import { usePlanUsage } from "@/lib/queries/plan-usage";
import { useEditorState } from "@/lib/editor-state-context";
import { formatTokens, formatReset, usageSeverity } from "@/lib/chat/format-usage";
import type { PlanUsageWindows, PlanWindow } from "@/lib/claude/plan-usage";

const SEVERITY_TEXT: Record<ReturnType<typeof usageSeverity>, string> = {
  ok: "text-muted-foreground",
  warn: "text-amber-500",
  critical: "text-red-500",
};

function Ring({ pct, className }: { pct: number; className: string }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  const filled = Math.min(1, Math.max(0, pct)) * c;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className={className} aria-hidden>
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <circle
        cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2"
        strokeDasharray={`${filled} ${c - filled}`}
        strokeLinecap="round"
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

function BarRow({
  label, pct, sub,
}: { label: string; pct: number; sub?: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-4 text-xs">
        <span className="text-foreground">{label}</span>
        <span className="text-muted-foreground">{`${Math.round(pct * 100)}%`}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${pct >= 0.8 ? "bg-amber-500" : "bg-primary"}`}
          style={{ width: `${Math.min(100, Math.round(pct * 100))}%` }}
        />
      </div>
      {sub ? <div className="text-[10px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

/** Plan windows in display order with their labels. */
const PLAN_ROWS: Array<{ key: keyof PlanUsageWindows; label: string }> = [
  { key: "fiveHour", label: "Session (5h)" },
  { key: "sevenDay", label: "Week (all models)" },
  { key: "sevenDayOpus", label: "Week (Opus)" },
  { key: "sevenDaySonnet", label: "Week (Sonnet)" },
];

/** Budget section — authoritative per-window plan usage via the local
 *  Claude Code token (lib/claude/plan-usage.ts). When the token isn't
 *  accessible we show NO rows, only an explanatory line (user decision). */
function PlanUsageSection({ open }: { open: boolean }) {
  const query = usePlanUsage(open);
  const data = query.data;
  if (!data) return null; // loading — the section appears when resolved

  if (!data.available) {
    return (
      <div className="border-t border-border pt-2 text-[11px] leading-snug text-muted-foreground">
        {data.reason === "no_token"
          ? "Plan usage unavailable — Claude Code token isn't accessible on this machine."
          : "Plan usage unavailable right now."}
      </div>
    );
  }

  const rows = PLAN_ROWS.flatMap(({ key, label }) => {
    const w: PlanWindow | null = data.windows[key];
    return w && w.utilization !== null ? [{ key, label, window: w }] : [];
  });
  if (rows.length === 0) return null;

  return (
    <div className="space-y-3 border-t border-border pt-2">
      {rows.map(({ key, label, window: w }) => (
        <BarRow
          key={key}
          label={label}
          pct={(w.utilization ?? 0) / 100}
          sub={w.resetsAt ? `resets ${formatReset(w.resetsAt)}` : undefined}
        />
      ))}
    </div>
  );
}

export default function ContextUsageChip({ sessionId }: { sessionId: string | null }) {
  const { usage } = useSessionContext(sessionId);
  const { activeProviderId } = useEditorState();
  const [open, setOpen] = useState(false);
  if (!usage) return null;

  const pct = usage.size > 0 ? usage.used / usage.size : 0;
  const severity = usageSeverity(pct);
  // The plan endpoint is Claude-subscription-specific — other agents (codex)
  // get no budget section rather than a misleading "token" message.
  const isClaude = activeProviderId === "claude-code";

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) trackEvent("context_meter_opened");
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Context usage"
            title={`${formatTokens(usage.used)} / ${formatTokens(usage.size)} tokens`}
            className={`flex h-8 cursor-pointer items-center gap-1 rounded-lg px-1.5 text-xs transition-colors outline-none hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-ring/50 ${SEVERITY_TEXT[severity]}`}
          />
        }
      >
        <Ring pct={pct} className="shrink-0" />
        <span>{Math.round(pct * 100)}%</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-64 space-y-3 p-3">
        <BarRow
          label="Context"
          pct={pct}
          sub={`${formatTokens(usage.used)} / ${formatTokens(usage.size)} tokens`}
        />
        {isClaude ? <PlanUsageSection open={open} /> : null}
        {/* No cost row (user decision 2026-07-05): the adapter's cost figure
            is API-priced and misleading on subscription auth, and neither
            Claude Code nor Codex surfaces an equivalent. `usage.cost` stays
            in the data layer only. */}
      </PopoverContent>
    </Popover>
  );
}
