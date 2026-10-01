"use client";

import { Film, Music } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import type { AudioRightsClass } from "@/lib/audio-rights/types";
import type { ExportAudioTrack, ExportPurpose } from "./audio-defaults";

export const INCLUDE_WARNING =
  "Social platforms may mute, block or claim videos with copyrighted music. Posting from libi attaches the platform's licensed copy instead where it can.";

const CHIP: Record<AudioRightsClass | "unknown", string> = { copyrighted: "©", generated: "libi", owned: "yours", unknown: "unknown" };
const PURPOSE_LABEL: Record<ExportPurpose, string> = { social: "Social / ad post", personal: "Personal" };

/** The export dialog's right column (addendum §7): what the export is for, then every track with an Include switch. */
export function ExportAudioSection({
  tracks,
  purpose,
  onPurpose,
  isOn,
  onToggle,
  loading = false,
  error = false,
  onRetry,
}: {
  tracks: ExportAudioTrack[];
  purpose: ExportPurpose;
  onPurpose: (p: ExportPurpose) => void;
  isOn: (t: ExportAudioTrack) => boolean;
  onToggle: (fileId: string, on: boolean) => void;
  /** The piece's audio rights are still loading — an empty `tracks` here
   *  means "not known yet", never "no audio": show a skeleton, not the
   *  empty-piece message. */
  loading?: boolean;
  /** The piece's audio rights failed to load — offer "Try again" rather
   *  than silently reading as an audio-free piece. */
  error?: boolean;
  onRetry?: () => void;
}) {
  const warn = !loading && !error && purpose === "social" && tracks.some((t) => t.rights === "copyrighted" && isOn(t));
  return (
    <div className="flex flex-col gap-3" data-testid="export-audio-section">
      <div>
        <div className="mb-1.5 text-xs font-medium">What&apos;s this export for?</div>
        <div role="radiogroup" data-testid="export-purpose" className="flex overflow-hidden rounded-md border border-border">
          {(["social", "personal"] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={purpose === p}
              data-testid={`export-purpose-${p}`}
              onClick={() => onPurpose(p)}
              className={`flex-1 cursor-pointer px-3 py-1.5 text-xs ${purpose === p ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
            >
              {PURPOSE_LABEL[p]}
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-1.5 text-xs font-medium">Tracks</div>
        {loading ? (
          // Mirrors the real row layout (icon, label, chip, switch) — the
          // house skeleton convention, never a spinner or "Loading…" text.
          <ul data-testid="export-audio-loading" aria-busy="true" className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex items-center gap-2">
                <Skeleton className="size-3.5 shrink-0 rounded-sm" />
                <Skeleton className="h-3 flex-1" />
                <Skeleton className="h-3 w-6 shrink-0" />
                <Skeleton className="h-[18px] w-8 shrink-0 rounded-full" />
              </li>
            ))}
          </ul>
        ) : error ? (
          <div data-testid="export-audio-error" className="flex items-center justify-between gap-2 text-xs text-red-600 dark:text-red-400">
            <span>Couldn&apos;t load this piece&apos;s audio.</span>
            <Button variant="outline" size="sm" onClick={onRetry} className="cursor-pointer" type="button">
              Try again
            </Button>
          </div>
        ) : tracks.length === 0 ? (
          <p data-testid="export-audio-empty" className="text-xs text-muted-foreground">
            This piece has no audio.
          </p>
        ) : (
          <ul data-testid="export-audio-list" className="flex max-h-64 flex-col gap-2 overflow-y-auto pr-1">
            {tracks.map((t) => (
              <li key={t.fileId} data-testid={`export-audio-row-${t.fileId}`} className="flex flex-col gap-0.5 text-xs">
                <div className="flex items-center gap-2">
                  {t.fileType === "video" ? <Film className="size-3.5 shrink-0 text-muted-foreground" /> : <Music className="size-3.5 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0 flex-1 truncate">{t.label}</span>
                  <span data-testid={`export-audio-chip-${t.fileId}`} className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
                    {CHIP[t.rights ?? "unknown"]}
                  </span>
                  <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-muted-foreground">
                    <Switch
                      data-testid={`export-audio-include-${t.fileId}`}
                      aria-label={`Include in video: ${t.label}`}
                      checked={isOn(t)}
                      onCheckedChange={(v: boolean) => onToggle(t.fileId, v)}
                      className="cursor-pointer"
                    />
                    Include
                  </label>
                </div>
                {t.rights === "copyrighted" && t.platformsLine && (
                  <p data-testid={`export-audio-platforms-${t.fileId}`} className="pl-5 text-[11px] text-muted-foreground">
                    {t.platformsLine}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        {warn && (
          <p data-testid="export-copyrighted-warning" className="mt-2 rounded bg-amber-500/10 px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400">
            {INCLUDE_WARNING}
          </p>
        )}
      </div>
    </div>
  );
}
