"use client";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Check, X, Loader2, RotateCw } from "lucide-react";
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
  /** Optional retry handler — when provided + status is "failed", renders a retry button next to the chip. */
  onRetry?: () => void;
  retryPending?: boolean;
}

function progressPercent(downloaded?: number, total?: number): number | null {
  if (!total || total <= 0 || downloaded === undefined) return null;
  const pct = Math.round((downloaded / total) * 100);
  return Math.max(0, Math.min(100, pct));
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
            className="cursor-pointer inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            <RotateCw className={`size-3 ${retryPending ? "animate-spin" : ""}`} />
            {retryPending ? "Retrying…" : "Retry"}
          </button>
        )}
      </span>
    );
  }

  // "pending" — not yet started (or legacy row with !installed and no runtimeStatus)
  return (
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
          <p className="max-w-xs">
            {binary} is queued. Download will start automatically.
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
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
