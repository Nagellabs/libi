"use client";

import { Button } from "@/components/ui/button";
import { activeLine, activePercent } from "@/lib/exports/list-view";
import { isActiveExport, type ExportRecordView } from "@/lib/exports/types";

/**
 * The export the composer sent the user to make, as the record says it is.
 * Rendering: the same waiting / progress line the Exports tab shows (a queued
 * export says WHY it waits). Failed or cancelled: said plainly, with a way to
 * try again. A finished one is not shown here — the composer selects it.
 */
export function ExportAwait({
  record,
  onTryAgain,
  onDismiss,
}: {
  record: ExportRecordView;
  onTryAgain: () => void;
  onDismiss: () => void;
}) {
  if (isActiveExport(record)) {
    const pct = activePercent(record);
    return (
      <div className="space-y-1.5 rounded-lg border border-border p-3" data-testid="export-await" data-state={record.status}>
        <p className="text-sm font-medium">Exporting {record.name} for this post…</p>
        <div className="h-1 overflow-hidden rounded bg-muted">
          <div
            className={"h-full bg-primary " + (pct == null ? "w-1/3 animate-pulse" : "transition-[width]")}
            style={pct == null ? undefined : { width: `${pct}%` }}
          />
        </div>
        <p role="status" className="text-xs text-muted-foreground" data-testid="export-await-line">
          {activeLine(record)}
        </p>
        <p className="text-xs text-muted-foreground">It is selected here as soon as it finishes — you can keep going meanwhile.</p>
      </div>
    );
  }
  if (record.status === "done") {
    return (
      <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3" data-testid="export-await" data-state="done">
        <p className="text-sm text-destructive" role="alert">
          The export {record.name} finished, but libi can&apos;t read its file, so it can&apos;t be posted. Export it again, or pick another export.
        </p>
        <div className="flex gap-2">
          <Button size="sm" className="cursor-pointer" data-testid="export-await-retry" onClick={onTryAgain}>
            Try again
          </Button>
          <Button size="sm" variant="ghost" className="cursor-pointer" data-testid="export-await-dismiss" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    );
  }
  const failed = record.status === "failed";
  return (
    <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3" data-testid="export-await" data-state={record.status}>
      <p className="text-sm text-destructive" role="alert">
        {failed ? `The export ${record.name} failed${record.error ? `: ${record.error}` : "."}` : `The export ${record.name} was cancelled.`}
      </p>
      <div className="flex gap-2">
        <Button size="sm" className="cursor-pointer" data-testid="export-await-retry" onClick={onTryAgain}>
          Try again
        </Button>
        <Button size="sm" variant="ghost" className="cursor-pointer" data-testid="export-await-dismiss" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
