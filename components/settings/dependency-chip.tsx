"use client";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Check, Download, X, Loader2, RotateCw } from "lucide-react";
import type { DepRuntimeStatus } from "@/lib/queries/mcp-servers";

interface DependencyChipProps {
  binary: string;
  installed: boolean;
  path: string | null;
  source: "system" | "bundled" | null;
  runtimeStatus?: DepRuntimeStatus;
  error?: string | null;
  bytesDownloaded?: number;
  bytesTotal?: number;
  /**
   * libi installs this dep on demand (`BundledDependency.manualInstall`):
   * inside the first job that needs it, never at boot. The chip then offers
   * a Download button while pending and a Re-download action once installed
   * — the manual route the row's copy promises. Without it, "pending" means
   * Category A will get to it, and the chip says so. The copy names no size
   * and no job: two rows carry on-demand deps now (libi-export's chromium,
   * youtube-download's uv + yt-dlp) and each row's description states its
   * own figure and trigger.
   */
  manualInstall?: boolean;
  /** Retry / Download / Re-download handler — all three POST the same
   *  retry-dep route. Without it no control renders in any state. */
  onRetry?: () => void;
  retryPending?: boolean;
}

function progressPercent(downloaded?: number, total?: number): number | null {
  if (!total || total <= 0 || downloaded === undefined) return null;
  const pct = Math.round((downloaded / total) * 100);
  return Math.max(0, Math.min(100, pct));
}

const actionClass =
  "cursor-pointer inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted disabled:opacity-50";

function ActionButton({
  label,
  ariaLabel,
  tip,
  icon,
  onClick,
  disabled,
  spinning,
}: {
  label: string;
  ariaLabel: string;
  tip: string;
  icon: "download" | "rotate";
  onClick: () => void;
  disabled?: boolean;
  spinning?: boolean;
}) {
  const Icon = icon === "download" ? Download : RotateCw;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={ariaLabel}
            className={actionClass}
          >
            <Icon className={`size-3 ${spinning ? "animate-spin" : ""}`} />
            {label}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <p className="max-w-xs">{tip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function DependencyChip({
  binary,
  installed,
  path,
  source,
  runtimeStatus,
  error,
  bytesDownloaded,
  bytesTotal,
  manualInstall,
  onRetry,
  retryPending,
}: DependencyChipProps) {
  // Prefer explicit runtimeStatus when present; fall back to the installed
  // boolean so legacy rows still render correctly.
  const status: DepRuntimeStatus = runtimeStatus ?? (installed ? "installed" : "pending");

  if (status === "installed") {
    const tip =
      source === "system"
        ? `${binary} found on system PATH`
        : `${binary} installed at ${path ?? "(bundled)"}`;
    return (
      <span className="inline-flex items-center gap-1">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Badge
                variant="outline"
                className="border-green-600 text-green-600 gap-1.5 cursor-default"
              >
                <Check className="size-3" />
                {binary}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs">{tip}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {manualInstall && onRetry && (
          <ActionButton
            label={retryPending ? "Re-downloading…" : "Re-download"}
            ariaLabel={`Re-download ${binary}`}
            tip={`Replaces the current ${binary}; use when the tools that need it fail to launch it.`}
            icon="rotate"
            onClick={onRetry}
            disabled={retryPending}
            spinning={retryPending}
          />
        )}
      </span>
    );
  }

  if (status === "installing") {
    const pct = progressPercent(bytesDownloaded, bytesTotal);
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Badge
              variant="outline"
              className="border-yellow-600 text-yellow-600 gap-1.5 cursor-default"
            >
              <Loader2 className="size-3 animate-spin" />
              {binary}
              {pct !== null && <span className="tabular-nums">{pct}%</span>}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            <p className="max-w-xs">
              Downloading {binary}{pct !== null ? ` — ${pct}%` : "…"}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Badge
                variant="outline"
                className="border-red-600 text-red-600 gap-1.5 cursor-default"
              >
                <X className="size-3" />
                {binary}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs">{error ?? `${binary} install failed.`}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={retryPending || runtimeStatus === "installing"}
            aria-label={`Retry ${binary}`}
            className={actionClass}
          >
            <RotateCw className={`size-3 ${retryPending ? "animate-spin" : ""}`} />
            {retryPending ? "Retrying…" : "Retry"}
          </button>
        )}
      </span>
    );
  }

  // "pending" — not yet started (or legacy row with !installed and no runtimeStatus)
  const pendingTip = manualInstall
    ? `${binary} is downloaded on demand — by the first tool call that needs it, or from the Download button here.`
    : `${binary} is queued. Download will start automatically.`;
  return (
    <span className="inline-flex items-center gap-1">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Badge
              variant="outline"
              className="border-muted-foreground/40 text-muted-foreground gap-1.5 cursor-default"
            >
              <Loader2 className="size-3" />
              {binary}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            <p className="max-w-xs">{pendingTip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {manualInstall && onRetry && (
        <ActionButton
          label={retryPending ? "Downloading…" : "Download"}
          ariaLabel={`Download ${binary}`}
          tip={`Downloads ${binary} now; otherwise it happens on the first tool call that needs it.`}
          icon="download"
          onClick={onRetry}
          disabled={retryPending}
          spinning={retryPending}
        />
      )}
    </span>
  );
}

export function DependencyChipSkeleton({ binary }: { binary: string }) {
  return (
    <Badge variant="outline" className="gap-1.5 cursor-default">
      <Loader2 className="size-3 animate-spin" />
      {binary}
    </Badge>
  );
}
