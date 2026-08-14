"use client";

import { useState } from "react";
import { useAllJobs, useCancelJob, useRetryJob } from "@/lib/queries/jobs";
import type { JobStatus } from "@/lib/jobs/types";

const STATUS_FILTERS: Array<{ label: string; value: JobStatus | "all" }> = [
  { label: "All", value: "all" },
  { label: "Running", value: "running" },
  { label: "Queued", value: "queued" },
  { label: "Failed", value: "failed" },
  { label: "Cancelled", value: "cancelled" },
  { label: "Completed", value: "completed" },
];

function formatEta(ms: number | null): string {
  if (ms == null) return "—";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

function formatStartedAt(d: Date | string | null): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = date.toLocaleTimeString(undefined, { hour12: false });
  return `${day}, ${time}`;
}

/** "1867624/1867624 bytes" reads terribly and blows up the column width —
 *  render byte units as MB once they pass 1 MB. Other units pass through. */
export function formatProgressCounts(
  done: number,
  total: number,
  unit: string,
): string {
  if (unit === "bytes" && total >= 1_000_000) {
    const mb = (n: number) => (n / 1_000_000).toFixed(1);
    return `${mb(done)}/${mb(total)} MB`;
  }
  return `${done}/${total} ${unit}`;
}

export function JobsTab() {
  const [filter, setFilter] = useState<JobStatus | "all">("all");
  const { data, isLoading, error } = useAllJobs(
    filter === "all" ? undefined : { status: filter },
  );
  const cancelMutation = useCancelJob();
  const retryMutation = useRetryJob();

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading jobs…</div>;
  }
  if (error) {
    return (
      <div className="text-sm text-destructive">
        Failed to load jobs:{" "}
        {error instanceof Error ? error.message : String(error)}
      </div>
    );
  }

  const jobs = data?.jobs ?? [];

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`cursor-pointer rounded-md border px-3 py-1 text-xs transition-colors ${
              filter === f.value
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {jobs.length === 0 ? (
        <div className="rounded-md border border-border p-8 text-center text-sm text-muted-foreground">
          No jobs matching this filter.
        </div>
      ) : (
        <div className="rounded-md border border-border overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/40">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium">Kind</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Progress</th>
                <th className="px-3 py-2 font-medium">ETA</th>
                <th className="px-3 py-2 font-medium">Started</th>
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const isInflight =
                  job.status === "running" ||
                  job.status === "queued" ||
                  job.status === "cancel-requested";
                const isTerminal =
                  job.status === "failed" || job.status === "cancelled";
                const pct =
                  job.progressTotal > 0
                    ? Math.floor((job.progressDone / job.progressTotal) * 100)
                    : null;
                return (
                  <tr key={job.id} className="border-t border-border/50">
                    <td className="px-3 py-2 font-mono text-[11px] whitespace-nowrap">{job.kind}</td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          job.status === "running"
                            ? "text-blue-500"
                            : job.status === "completed"
                              ? "text-green-500"
                              : job.status === "failed"
                                ? "text-destructive"
                                : job.status === "cancelled" ||
                                    job.status === "cancel-requested"
                                  ? "text-yellow-500"
                                  : "text-muted-foreground"
                        }
                      >
                        {job.status}
                      </span>
                      {job.error && (
                        <div
                          className="mt-0.5 max-w-[260px] truncate text-[10px] text-destructive/70"
                          title={job.error}
                        >
                          {job.error}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {pct != null
                        ? `${pct}% (${formatProgressCounts(job.progressDone, job.progressTotal, job.progressUnit)})`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      {/* ETA only means something for in-flight jobs — a
                          completed job's 0s / a cancelled job's null both
                          render as the same empty dash. */}
                      {isInflight ? formatEta(job.etaMs) : "—"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      {formatStartedAt(job.startedAt)}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {isInflight && (
                        <button
                          onClick={() => cancelMutation.mutate(job.id)}
                          disabled={cancelMutation.isPending}
                          className="cursor-pointer text-destructive/70 hover:text-destructive disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      )}
                      {isTerminal && (
                        <button
                          onClick={() => retryMutation.mutate(job.id)}
                          disabled={retryMutation.isPending}
                          className="cursor-pointer text-primary/80 hover:text-primary disabled:opacity-50"
                        >
                          Retry
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
