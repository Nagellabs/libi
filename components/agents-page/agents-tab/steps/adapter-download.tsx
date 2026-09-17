"use client";

import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import type { AdapterDownloadCopy } from "@/lib/agents/adapter-copy";

/** Where the download of an agent's chat support stands, as the install step reads it. */
export type AdapterDownloadPhase =
  | { kind: "ready" }
  /**
   * No job is in flight yet. `requested`: this visit's start already reached the
   * server, so to the user the download is under way — reading "Starting" again
   * in the gap before the job shows up would run the labels backwards.
   * `stalled`: the wait hasn't moved for a few seconds and Retry is offered.
   */
  | { kind: "starting"; requested: boolean; stalled: boolean; lastError: string | null }
  /** `doneMb`/`totalMb` are null when the job reports no MB (a skipped install reports a step count). */
  | { kind: "downloading"; doneMb: number | null; totalMb: number | null; etaMs: number | null }
  | { kind: "failed"; cancelled: boolean; detail: string | null };

/** "less than a minute left" / "about 3 minutes left". The job's ETA is null when unknown, never when nearly done. */
export function remainingLabel(etaMs: number): string {
  if (etaMs < 60_000) return "less than a minute left";
  const minutes = Math.round(etaMs / 60_000);
  return minutes === 1 ? "about 1 minute left" : `about ${minutes} minutes left`;
}

/** What a screen reader hears as the download moves on. A failure has its own alert, so it says nothing here. */
function announcement(copy: AdapterDownloadCopy, phase: AdapterDownloadPhase): string {
  switch (phase.kind) {
    case "ready":
      return copy.downloaded;
    case "failed":
      return "";
    case "starting":
      return phase.stalled ? copy.stalled : phase.requested ? copy.downloading : copy.starting;
    case "downloading":
      return copy.downloading;
  }
}

/**
 * The download of libi's chat support for an agent, as its own panel: a moving
 * icon and title while it runs, a real progress bar, and how much is left. It is
 * the one thing the install step waits on, so it must never read as small print.
 *
 * The live region is one element that stays mounted through every phase: a region
 * that mounts already filled in is not announced, so each panel can't carry its own.
 */
export function AdapterDownload({ copy, phase }: { copy: AdapterDownloadCopy; phase: AdapterDownloadPhase }) {
  return (
    <>
      <p role="status" className="sr-only">
        {announcement(copy, phase)}
      </p>
      {/* Keyed by kind so a failure mounts a fresh role="alert" — a role added to a reused element often goes unannounced. */}
      <Panel key={phase.kind} copy={copy} phase={phase} />
    </>
  );
}

function Panel({ copy, phase }: { copy: AdapterDownloadCopy; phase: AdapterDownloadPhase }) {
  if (phase.kind === "ready") {
    return (
      <div data-testid="wizard-adapter" className="flex items-center gap-2 text-sm text-foreground">
        <CircleCheck aria-hidden className="size-4 shrink-0 text-emerald-500" />
        <p>{copy.downloaded}</p>
      </div>
    );
  }

  if (phase.kind === "failed") {
    return (
      <div
        data-testid="wizard-adapter"
        role="alert"
        className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/5 p-3"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <CircleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
          <p>{phase.cancelled ? copy.cancelled : copy.failed}</p>
        </div>
        {phase.detail ? <p className="break-words pl-6 text-xs text-muted-foreground">{phase.detail}</p> : null}
      </div>
    );
  }

  // A wait that stopped moving: nothing on the panel may still look busy while the button offers Retry.
  if (phase.kind === "starting" && phase.stalled) {
    return (
      <div data-testid="wizard-adapter" className="space-y-1 rounded-lg border border-amber-400/40 bg-amber-400/5 p-3">
        <div data-testid="wizard-adapter-stalled" className="flex items-center gap-2 text-sm font-medium text-foreground">
          <CircleAlert aria-hidden className="size-4 shrink-0 text-amber-400" />
          <p>{copy.stalled}</p>
        </div>
        {phase.lastError ? (
          <p className="break-words pl-6 text-xs text-muted-foreground">{`The last attempt said: ${phase.lastError}`}</p>
        ) : null}
        <p data-testid="wizard-adapter-needed" className="pl-6 text-xs text-muted-foreground">
          {copy.needed}
        </p>
      </div>
    );
  }

  const underWay = phase.kind === "downloading" || phase.requested;
  const measured =
    phase.kind === "downloading" && phase.doneMb !== null && phase.totalMb !== null && phase.totalMb > 0
      ? { doneMb: phase.doneMb, totalMb: phase.totalMb, etaMs: phase.etaMs }
      : null;
  // Nothing has landed yet while npm resolves the tree: a bar parked at 0% looks
  // stuck, so it keeps moving until the first megabyte arrives.
  const landed = measured && measured.doneMb > 0 ? measured : null;
  const percent = landed ? Math.min(100, Math.round((landed.doneMb / landed.totalMb) * 100)) : null;
  // The MB figure is an estimate the runner caps at the total, and its ETA reaches
  // zero and stays there, so a bigger tree or a slow last npm step would sit at
  // "56 of 56 MB · less than a minute left" for as long as it takes.
  const readout = !landed
    ? null
    : landed.doneMb >= landed.totalMb
      ? "Finishing up…"
      : [
          `${Math.round(landed.doneMb)} of ${Math.round(landed.totalMb)} MB`,
          landed.etaMs !== null ? remainingLabel(landed.etaMs) : null,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <div data-testid="wizard-adapter" className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <div
        data-testid={underWay ? "wizard-adapter-progress" : "wizard-adapter-starting"}
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
      >
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          <LoaderCircle aria-hidden className="size-4 shrink-0 text-primary motion-safe:animate-spin" />
          <p>{underWay ? copy.downloading : copy.starting}</p>
        </div>
        {readout ? <p className="shrink-0 text-xs tabular-nums text-muted-foreground">{readout}</p> : null}
      </div>
      <DownloadBar percent={percent} />
      {/* The CLI is the user's and already here; what libi fetches is its own support for it. */}
      <p data-testid="wizard-adapter-needed" className="text-xs text-muted-foreground">
        {copy.needed}
      </p>
    </div>
  );
}

function DownloadBar({ percent }: { percent: number | null }) {
  return (
    <div
      data-testid="wizard-adapter-bar"
      role="progressbar"
      aria-label="Download progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      {percent === null ? (
        // Reduced motion: a still, faint fill instead of the sliding band.
        <div className="absolute inset-y-0 left-0 w-2/5 rounded-full bg-primary/60 animate-[libi-export-shimmer_1.2s_ease-in-out_infinite] motion-reduce:w-full motion-reduce:animate-none motion-reduce:bg-primary/20" />
      ) : (
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  );
}
