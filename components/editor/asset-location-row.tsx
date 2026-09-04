"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { FolderOpen, Copy, Check } from "lucide-react";
import { useFileLocation } from "@/lib/queries/files";
import { revealFile, revealLabel, getShellPlatform } from "@/lib/shell/client";
import { trackEvent } from "@/lib/analytics/client";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * "Location" row for the asset Summary tab: the file's absolute path on
 * disk, a reveal button, and a copy button.
 *
 * Rendered ABOVE the summary's StepStateGate on purpose — the gate shows
 * "No summary yet" and nothing else for an un-analyzed asset, which is
 * most of them, and the whole point of this row is to work regardless of
 * analysis state.
 */
export function AssetLocationRow({ fileId }: { fileId: string }) {
  const { data, isLoading } = useFileLocation(fileId);
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const path = data?.path;

  const handleReveal = useCallback(() => {
    if (!path) return;
    trackEvent("asset_revealed", { source: "summary_tab" });
    // Reveal is fire-and-forget by design and this is a button click with
    // nowhere to surface an error, so swallow a rejecting bridge call or
    // rejecting fetch rather than let it escape as an unhandled rejection.
    void revealFile(path).catch(() => {});
  }, [path]);

  const handleCopy = useCallback(() => {
    if (!path) return;
    void navigator.clipboard
      .writeText(path)
      .then(() => {
        setCopied(true);
        if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Clipboard can be unavailable (insecure context, denied
        // permission). Nothing to recover — just don't flash "Copied".
      });
  }, [path]);

  if (isLoading) {
    return (
      <div data-testid="asset-location-skeleton" className="mb-4 space-y-1.5">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-4 w-full" />
      </div>
    );
  }

  // No row (404) or an error — render nothing rather than an error state.
  // A missing file row means the asset panel itself is about to close.
  if (!data || !path) return null;

  const label = revealLabel(getShellPlatform());

  return (
    <section className="mb-4">
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Location
      </h4>
      <div className="flex items-start gap-2 rounded border bg-muted/30 p-2">
        <code
          data-testid="asset-location-path"
          title={path}
          className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed text-muted-foreground"
        >
          {path}
        </code>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            data-testid="asset-location-reveal"
            onClick={handleReveal}
            disabled={!data.exists}
            title={data.exists ? label : "File is no longer on disk"}
            aria-label={label}
            className="cursor-pointer flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <FolderOpen className="size-3.5" />
          </button>
          <button
            type="button"
            data-testid="asset-location-copy"
            onClick={handleCopy}
            title={copied ? "Copied" : "Copy path"}
            aria-label="Copy path"
            className="cursor-pointer flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
        </div>
      </div>
    </section>
  );
}
