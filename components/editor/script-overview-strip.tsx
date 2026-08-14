"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTimecode } from "@/lib/utils/format";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { PersistedScript } from "@/lib/analysis/scripts";
import {
  SCRIPT_REFRESH_COST_MAX_ATTEMPTS,
  useRefreshScriptCost,
  type ScriptRefreshCostOutcome,
} from "@/lib/queries/scripts";

function humanizeDate(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d as string);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Single source of truth for per-provider display strings. Adding a new
 *  script provider is a one-row addition here: friendly name, the model
 *  labels we want to show, and the estimate-explanation tooltip body that
 *  quotes the provider's actual list rate.
 *
 *  Anything not in this map falls through to a sensible generic. */
const PROVIDER_INFO: Record<
  string,
  {
    /** Friendly provider name (shown in the violet pill + tooltips). */
    displayName: string;
    /** Per-provider friendly model labels. Falls back to raw id. */
    models: Record<string, string>;
    /** Tooltip body shown while the cost is estimated. Quote the real
     *  rate so the user can sanity-check the number; the generic
     *  fallback (below) is intentionally bland. */
    estimateExplanation: string;
  }
> = {
  "fal-video-understanding": {
    displayName: "fal.ai",
    models: {
      "gemini-2.5-pro": "Gemini 2.5 Pro",
      "gemini-2.5-flash": "Gemini 2.5 Flash",
    },
    estimateExplanation:
      "Estimated from video duration at fal-ai/video-understanding's list rate ($0.01 per 5 seconds). fal hasn't published the real charge yet — billing data usually arrives within hours but can take a few days. Click the chip to check now; if it's not ready yet you can try again later.",
  },
};

const GENERIC_ESTIMATE_EXPLANATION =
  "Estimated from input characteristics. The real charge isn't available yet — click the chip to check now. The provider's billing data may take time to arrive.";

/** Pretty-print the model identifier in the context of a provider.
 *  Falls back to the raw id so newly-added models surface SOMETHING
 *  rather than disappearing. */
function modelLabel(providerId: string, modelId: string): string {
  return PROVIDER_INFO[providerId]?.models[modelId] ?? modelId;
}

/** Pretty-print the provider identifier (the slug used in our DB kind). */
function providerLabel(providerId: string): string {
  return PROVIDER_INFO[providerId]?.displayName ?? providerId;
}

/** Per-provider explanation of how we compute the estimate. Quotes the
 *  real rate when known; falls back to a generic explanation otherwise. */
function estimateExplanation(providerId: string): string {
  return PROVIDER_INFO[providerId]?.estimateExplanation ?? GENERIC_ESTIMATE_EXPLANATION;
}

/** Format a USD amount with the right precision. Sub-dollar amounts get 4
 *  decimals (e.g. $0.0832); larger amounts get 2 (e.g. $1.50). */
function formatUsd(amount: number): string {
  if (amount === 0) return "$0";
  if (amount < 1) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

/** Format the time-since label used in the chip tooltip and small inline
 *  surface ("Last checked Xm ago"). Uses minutes for < 1h, hours for < 1d. */
function formatTimeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function musicSummary(m: {
  present: boolean;
  genre?: string;
  tempo?: string;
  instruments?: string[];
}): string | null {
  if (!m.present) return null;
  const parts: string[] = [];
  if (m.genre) parts.push(m.genre);
  if (m.tempo) parts.push(m.tempo);
  if (m.instruments && m.instruments.length > 0) parts.push(m.instruments.join(", "));
  return parts.length > 0 ? parts.join(" · ") : "music present";
}

interface Props {
  persisted: PersistedScript;
  onRegenerate: () => void;
  onSeek: (t: number) => void;
}

export function ScriptOverviewStrip({ persisted, onRegenerate, onSeek }: Props) {
  const { script, providerId, modelId, step } = persisted;

  const onCopy = useCallback(() => {
    navigator.clipboard.writeText(JSON.stringify(script, null, 2)).catch(() => {});
  }, [script]);

  const music = musicSummary(script.music);
  const hasDialogueSummary =
    typeof script.dialogue_summary === "string" &&
    script.dialogue_summary.trim().length > 0;

  return (
    <div className="border-b border-border bg-muted/40 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm">
          <div className="flex items-baseline gap-3">
            <span className="text-foreground">{script.overall_style}</span>
            {script.pacing && (
              <span className="text-xs text-muted-foreground">
                pacing: {script.pacing}
              </span>
            )}
          </div>
          {music && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-foreground">
              <span aria-hidden>♫</span>
              <span>{music}</span>
              {(script.music.cues ?? []).map((c, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => onSeek(c.timestamp)}
                  title={c.description}
                  aria-label={`Seek to ${formatTimecode(c.timestamp)} — ${c.description}`}
                  className="cursor-pointer rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-mono text-muted-foreground hover:bg-surface-hover hover:text-foreground"
                >
                  {formatTimecode(c.timestamp)}
                </button>
              ))}
            </div>
          )}
          {hasDialogueSummary && (
            <div className="text-xs text-foreground">
              <span aria-hidden>🗩</span> {script.dialogue_summary}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-300"
              title="AI-generated via an external model"
            >
              <Sparkles className="size-3" aria-hidden />
              {modelLabel(providerId, modelId)} · {providerLabel(providerId)}
              {typeof script.provider?.costUsd === "number" && (
                <>
                  <span aria-hidden>·</span>
                  <CostBadge
                    fileId={step.fileId}
                    kind={step.kind}
                    providerId={providerId}
                    costUsd={script.provider.costUsd}
                    costEstimated={!!script.provider.costEstimated}
                    requestId={script.provider.requestId}
                    costLastCheckedAt={script.provider.costLastCheckedAt}
                  />
                </>
              )}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {humanizeDate(step.createdAt)}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton onClick={onCopy} label="Copy JSON" icon={Copy} />
          <IconButton onClick={onRegenerate} label="Regenerate" icon={RefreshCw} />
        </div>
      </div>
    </div>
  );
}

function IconButton({
  onClick,
  label,
  icon: Icon,
}: {
  onClick: () => void;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "cursor-pointer flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-hover hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" />
    </button>
  );
}

/** The cost portion of the AI-source pill. Five visual states:
 *  - **real (confirmed)**: `$X.XX ✓` with tooltip noting "Real cost from <provider>".
 *  - **real (just-confirmed by refresh)**: same as above, but tooltip adds "Confirmed Xm ago".
 *  - **estimated, clickable**: `$X.XX est` (button). Tooltip explains estimate + click affordance.
 *  - **estimated, refreshing**: `$X.XX ⏳ N/M` (disabled). Tooltip shows attempt progress.
 *  - **estimated, legacy (no requestId)**: `$X.XX est` (static span). Tooltip explains why it can't be checked.
 *  The whole segment is wrapped in a single tooltip popup so hovering
 *  anywhere shows the explanation. */
function CostBadge({
  fileId,
  kind,
  providerId,
  costUsd,
  costEstimated,
  requestId,
  costLastCheckedAt,
}: {
  fileId: string;
  kind: string;
  providerId: string;
  costUsd: number;
  costEstimated: boolean;
  requestId?: string;
  costLastCheckedAt?: string;
}) {
  const { refresh, isPending, attempt, lastOutcome } = useRefreshScriptCost(
    fileId,
    kind,
  );

  // Transient "just checked" affordance — when a refresh completes without
  // resolving (still_pending / no_request_id / etc.), the chip looks
  // unchanged. Flash a 3-second "checked just now" hint so the user knows
  // their click did something.
  // Epoch counters instead of a Date.now() timestamp: the flash only ever
  // needs truthiness, and bumping an epoch during render (previous-state
  // pattern) avoids both the setState-in-effect cascade and an impure
  // Date.now() call in render. A new outcome mid-flash bumps the epoch,
  // which restarts the 3-second timer — same behavior as before.
  const [checkEpoch, setCheckEpoch] = useState(0);
  const [clearedEpoch, setClearedEpoch] = useState(0);
  const [prevOutcome, setPrevOutcome] = useState(lastOutcome);
  if (lastOutcome !== prevOutcome) {
    setPrevOutcome(lastOutcome);
    if (lastOutcome) setCheckEpoch(checkEpoch + 1);
  }
  const justChecked = checkEpoch > clearedEpoch;
  useEffect(() => {
    if (checkEpoch === clearedEpoch) return;
    const t = setTimeout(() => setClearedEpoch(checkEpoch), 3000);
    return () => clearTimeout(t);
  }, [checkEpoch, clearedEpoch]);

  const tooltipContent = buildTooltipContent({
    providerId,
    costEstimated,
    requestId,
    costLastCheckedAt,
    isPending,
    attempt,
    justChecked,
    lastOutcome,
  });

  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          render={<span className="inline-flex items-center gap-1" />}
        >
          <span>{formatUsd(costUsd)}</span>
          {!costEstimated ? (
            <ConfirmedChip />
          ) : !requestId ? (
            <LegacyEstChip />
          ) : (
            <ClickableEstChip
              isPending={isPending}
              attempt={attempt}
              justChecked={justChecked}
              onClick={() => {
                if (!isPending) void refresh();
              }}
            />
          )}
        </TooltipTrigger>
        <TooltipContent className="max-w-[280px] whitespace-pre-line text-left">
          {tooltipContent}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Resolved real cost: a small green-tinted checkmark chip. */
function ConfirmedChip() {
  return (
    <span
      aria-label="Confirmed real cost"
      className="inline-flex items-center rounded-sm bg-emerald-500/15 px-1 text-emerald-700 dark:text-emerald-300"
    >
      <Check className="size-2.5" aria-hidden />
    </span>
  );
}

/** Static "est" chip for legacy rows where we can't look up real cost. */
function LegacyEstChip() {
  return (
    <span
      aria-label="Estimated cost (lookup unavailable)"
      className="rounded-sm bg-violet-500/20 px-1 text-[9px] uppercase tracking-wide text-violet-700 dark:text-violet-200"
    >
      est
    </span>
  );
}

/** Clickable "est" chip for current rows — fires the refresh-cost flow. */
function ClickableEstChip({
  isPending,
  attempt,
  justChecked,
  onClick,
}: {
  isPending: boolean;
  attempt: number;
  justChecked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPending}
      aria-label="Estimated cost. Click to fetch the real cost from the provider's billing API."
      className={cn(
        "rounded-sm bg-violet-500/20 px-1 text-[9px] font-medium uppercase tracking-wide text-violet-700 dark:text-violet-200",
        isPending
          ? "cursor-wait opacity-70"
          : "cursor-pointer hover:bg-violet-500/30 hover:text-violet-800 dark:hover:text-violet-100",
      )}
    >
      {isPending ? (
        <span className="inline-flex items-center gap-0.5">
          <Loader2 className="size-2.5 animate-spin" aria-hidden />
          {attempt}/{SCRIPT_REFRESH_COST_MAX_ATTEMPTS}
        </span>
      ) : justChecked ? (
        "checked"
      ) : (
        "est"
      )}
    </button>
  );
}

/** Build the tooltip body for the cost segment. The text varies by every
 *  meaningful combination of state — kept as one pure function so the
 *  resulting copy is easy to audit and tweak. */
function buildTooltipContent({
  providerId,
  costEstimated,
  requestId,
  costLastCheckedAt,
  isPending,
  attempt,
  justChecked,
  lastOutcome,
}: {
  providerId: string;
  costEstimated: boolean;
  requestId?: string;
  costLastCheckedAt?: string;
  isPending: boolean;
  attempt: number;
  justChecked: boolean;
  lastOutcome: ScriptRefreshCostOutcome | null;
}): string {
  const providerName = providerLabel(providerId);

  // Resolved real cost.
  if (!costEstimated) {
    let msg = `Real cost from ${providerName} billing.`;
    if (justChecked && lastOutcome?.status === "resolved") {
      msg += ` Just confirmed via the billing API.`;
    } else if (costLastCheckedAt) {
      msg += ` Confirmed ${formatTimeSince(costLastCheckedAt)}.`;
    }
    return msg;
  }

  // Estimated + legacy row (no requestId).
  if (!requestId) {
    return "Estimated cost. This script was generated before real-cost lookup was available — only the estimate exists for this row. Re-generate the script to enable on-demand lookup.";
  }

  // Estimated + refresh in flight.
  if (isPending) {
    return `Checking with ${providerName}… (attempt ${attempt} of ${SCRIPT_REFRESH_COST_MAX_ATTEMPTS}).`;
  }

  // Permanent credential problem — keep the explanation up (not just the
  // 3-second flash); retrying can't fix it until the key is replaced.
  if (lastOutcome?.status === "provider_permission_denied") {
    return explainOutcome(lastOutcome, providerId);
  }

  // Estimated + a refresh just finished.
  if (justChecked && lastOutcome && lastOutcome.status !== "resolved") {
    return explainOutcome(lastOutcome, providerId);
  }

  // Estimated + has been checked before, still pending.
  const base = estimateExplanation(providerId);
  if (costLastCheckedAt) {
    return `${base}\n\nLast checked ${formatTimeSince(costLastCheckedAt)} — ${providerName} hadn't published yet.`;
  }

  // Estimated, never checked.
  return base;
}

/** Human-readable outcome message, shown in the chip tooltip for ~3s after a
 *  refresh completes that didn't produce a real cost. */
function explainOutcome(
  outcome: ScriptRefreshCostOutcome,
  providerId: string,
): string {
  const providerName = providerLabel(providerId);
  switch (outcome.status) {
    case "still_pending":
      return `Just checked — ${providerName} hasn't published the real charge yet. Billing usually arrives within a few hours; try again later.`;
    case "provider_permission_denied":
      return (
        outcome.hint ??
        `The configured ${providerName} API key can't read billing data. Cost lookup needs an ADMIN-scoped key.`
      );
    case "no_request_id":
      return "This script row was generated before real-cost lookup was available. Re-generate the script to enable it.";
    case "no_provider_fetch_support":
      return `Real-cost lookup isn't supported for ${providerName}. The estimate is your best reference.`;
    case "stale":
      return "The script was re-generated while we were checking. The chip is showing the latest row.";
    case "error":
      return "Couldn't reach the provider's billing API. Try again in a moment.";
    case "resolved":
      // Should be unreachable — when resolved, chip re-renders without "est".
      return "Real cost resolved.";
  }
}
