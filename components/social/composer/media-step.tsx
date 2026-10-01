"use client";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { exportChoiceLabel, exportLine, exportSongNote, targetLabel, type FitResponse, type LatestExport } from "./types";

/**
 * Step 1 — what is being posted. The fit check is local, offline and free
 * (`lib/social/fit-check.ts`), so every problem is named here, per platform,
 * before anything is uploaded or sent. Instagram refuses to SCHEDULE a post
 * with no media at all, so this gate is not a publish-only gate.
 */
export function MediaStep({
  latestExport,
  exportPath,
  choices,
  onPick,
  fit,
  fitPending,
  fitFailed,
  hasTargets,
  exportPending = false,
  onExportRequested,
  onChangeTargets,
}: {
  latestExport: LatestExport | null;
  exportPath: string | null;
  choices: LatestExport[];
  onPick: (filePath: string) => void;
  fit: FitResponse | null;
  fitPending: boolean;
  fitFailed: boolean;
  hasTargets: boolean;
  /** An export started from this composer is still rendering. */
  exportPending?: boolean;
  onExportRequested: () => void;
  onChangeTargets: () => void;
}) {
  const current = choices.find((c) => c.filePath === exportPath) ?? latestExport;

  if (!exportPath || !current) {
    if (exportPending) {
      return (
        <div className="space-y-3" data-testid="media-step">
          <p className="text-sm text-muted-foreground">Your export is rendering. It appears here, selected, as soon as it finishes.</p>
        </div>
      );
    }
    return (
      <div className="space-y-3" data-testid="media-step">
        <p className="text-sm text-muted-foreground">
          This piece has no export yet. Export it as a 1080p MP4 and come straight back here.
        </p>
        <Button className="cursor-pointer" onClick={onExportRequested}>
          Export &amp; post
        </Button>
      </div>
    );
  }

  const failing = fit?.verdicts.filter((v) => !v.ok) ?? [];

  return (
    <div className="space-y-4" data-testid="media-step">
      <div className="space-y-1.5">
        <p className="text-sm font-medium" data-testid="export-line">
          {exportLine(current)}
        </p>
        {exportSongNote(current) && (
          <p className="text-xs text-muted-foreground" data-testid="export-song-note">
            This export is {exportSongNote(current)}.
          </p>
        )}
        {choices.length > 1 && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Pick another export…
            <select
              className="cursor-pointer rounded-md border border-border bg-background px-2 py-1 text-xs"
              value={exportPath}
              onChange={(e) => onPick(e.target.value)}
              aria-label="Export file"
            >
              {choices.map((c) => (
                <option key={c.filePath} value={c.filePath}>
                  {exportChoiceLabel(c)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {!hasTargets ? (
        <p className="text-sm text-muted-foreground">Pick at least one account on the next step to check this export against it.</p>
      ) : fitFailed ? (
        <p className="text-sm text-destructive" data-testid="fit-failed">
          This export could not be checked against those platforms — libi could not read it.
        </p>
      ) : fitPending ? (
        <div className="space-y-2" data-testid="fit-skeleton">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-40" />
        </div>
      ) : (
        <ul className="space-y-2">
          {(fit?.verdicts ?? []).map((v) => (
            <li key={`${v.platform}:${v.postType}`} className="text-sm">
              {v.ok ? (
                <span className="text-emerald-400" data-testid={`fit-ok-${v.platform}`}>
                  ✓ fits {targetLabel(v.platform, v.postType)}
                </span>
              ) : (
                <div className="space-y-1" data-testid={`fit-bad-${v.platform}`}>
                  <span className="text-destructive">✗ {targetLabel(v.platform, v.postType)}</span>
                  {v.problems.map((p) => (
                    <p key={p} className="text-destructive">
                      {p}
                    </p>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {failing.length > 0 && (
        <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-xs text-muted-foreground">
            Export it again at a size these platforms accept, or drop the target that doesn&apos;t fit.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="cursor-pointer" onClick={onChangeTargets}>
              Change targets
            </Button>
            <Button size="sm" variant="outline" className="cursor-pointer" onClick={onExportRequested}>
              Export again
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
