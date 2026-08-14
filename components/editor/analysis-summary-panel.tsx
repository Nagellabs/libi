// components/editor/analysis-summary-panel.tsx
"use client";

import type { VideoSummary } from "@/lib/analysis/types";

interface Props {
  summary: VideoSummary | null;
  onSeek?: (t: number) => void;
}

function formatTimecode(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function AnalysisSummaryPanel({ summary, onSeek }: Props) {
  if (!summary) {
    return <p className="text-sm text-muted-foreground">No summary yet</p>;
  }

  const hasCustom = summary.custom && Object.keys(summary.custom).length > 0;

  return (
    <div className="space-y-4 text-sm">
      {/* 1. Overview */}
      <p className="leading-relaxed text-foreground">{summary.overview}</p>

      {/* 2. Subjects */}
      {summary.subjects.length > 0 && (
        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Subjects
          </h4>
          <div className="grid gap-2 sm:grid-cols-2">
            {summary.subjects.map((subj) => {
              const shownTimestamps = subj.appearance_timestamps.slice(0, 5);
              const extraCount = subj.appearance_timestamps.length - shownTimestamps.length;
              return (
                <article
                  key={subj.id}
                  className="rounded border bg-muted/30 p-3 space-y-1"
                >
                  <header className="flex items-center gap-2">
                    <span className="inline-flex h-5 items-center rounded-full bg-primary px-2 text-xs font-medium text-primary-foreground">
                      {subj.id}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      appears in {subj.appearance_frame_indices.length} frame
                      {subj.appearance_frame_indices.length !== 1 ? "s" : ""}
                    </span>
                  </header>
                  <p className="text-xs text-muted-foreground">{subj.description}</p>
                  {shownTimestamps.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {shownTimestamps.map((ts) => (
                        <button
                          key={ts}
                          type="button"
                          onClick={() => onSeek?.(ts)}
                          className="cursor-pointer rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground hover:bg-muted/70"
                          title={`Seek to ${ts.toFixed(2)}s`}
                        >
                          {formatTimecode(ts)}
                        </button>
                      ))}
                      {extraCount > 0 && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          +{extraCount} more
                        </span>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {/* 3. Sections timeline */}
      {summary.sections.length > 0 && (
        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Sections
          </h4>
          <ol className="space-y-1.5">
            {summary.sections.map((sec, i) => (
              <li key={i} className="flex gap-3 rounded border bg-muted/30 p-2">
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {formatTimecode(sec.start)}–{formatTimecode(sec.end)}
                </span>
                <span className="text-xs">{sec.description}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* 4. Recurring objects */}
      {summary.recurring_objects.length > 0 && (
        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Recurring Objects
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {summary.recurring_objects.map((obj) => (
              <span
                key={obj.name}
                className="rounded-full border border-border bg-muted/30 px-2.5 py-0.5 text-xs"
              >
                {obj.name} ({obj.count})
              </span>
            ))}
          </div>
        </section>
      )}

      {/* 5. Visual style + audio summary */}
      {(summary.visual_style || summary.audio_summary) && (
        <section className="space-y-2">
          {summary.visual_style && (
            <div>
              <span className="mr-1.5 text-xs font-semibold text-muted-foreground">
                Visual style:
              </span>
              <span className="text-xs">{summary.visual_style}</span>
            </div>
          )}
          {summary.audio_summary && (
            <div>
              <span className="mr-1.5 text-xs font-semibold text-muted-foreground">
                Audio:
              </span>
              <span className="text-xs">{summary.audio_summary}</span>
            </div>
          )}
        </section>
      )}

      {/* 6. Custom block */}
      {hasCustom && (
        <section>
          <details className="rounded border bg-muted/30">
            <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-muted-foreground">
              Custom data ({Object.keys(summary.custom!).join(", ")})
            </summary>
            <pre className="overflow-auto px-3 pb-3 text-xs text-muted-foreground">
              {JSON.stringify(summary.custom, null, 2)}
            </pre>
          </details>
        </section>
      )}
    </div>
  );
}
