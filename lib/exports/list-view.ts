/**
 * Client-safe sorting, filtering and formatting for a piece's exports — the
 * Exports tab (components/editor/exports-tab.tsx) and the resources panel's
 * Exports folder (components/resources/piece-exports-node.tsx). Pure.
 */
import { EXPORT_ASPECTS, type ExportAspect, type ExportRecordView } from "./types";

export type ExportSort = "time-asc" | "time-desc" | "a-z" | "z-a";

/** Remembered per viewer (spec §A4). */
export const EXPORT_SORT_KEY = "libi:exports-sort";
export const DEFAULT_EXPORT_SORT: ExportSort = "time-asc";
export const EXPORT_SORT_LABELS: Record<ExportSort, string> = {
  "time-asc": "Oldest first",
  "time-desc": "Newest first",
  "a-z": "A → Z",
  "z-a": "Z → A",
};

export function loadExportSort(): ExportSort {
  try {
    const v = localStorage.getItem(EXPORT_SORT_KEY);
    if (v && Object.hasOwn(EXPORT_SORT_LABELS, v)) return v as ExportSort;
  } catch {
    // Storage blocked — the default.
  }
  return DEFAULT_EXPORT_SORT;
}

export function saveExportSort(sort: ExportSort): void {
  try {
    localStorage.setItem(EXPORT_SORT_KEY, sort);
  } catch {
    // Storage blocked — the choice lasts this session only.
  }
}

/**
 * When the user made the export: when it was queued. Never the finish time — a batch of six
 * queued as 1..6 finishes in render order, and a running row has no finish time at all.
 */
export function exportTime(e: Pick<ExportRecordView, "queuedAt">): number {
  return e.queuedAt;
}

export function sortExports<T extends Pick<ExportRecordView, "name" | "queuedAt">>(rows: T[], sort: ExportSort): T[] {
  const out = [...rows];
  // Equal queue times (a batch queued in one call) fall back to the name, natural-numeric so
  // "Batch 2" precedes "Batch 10".
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { numeric: true });
  switch (sort) {
    case "time-asc":
      return out.sort((a, b) => exportTime(a) - exportTime(b) || byName(a, b));
    case "time-desc":
      return out.sort((a, b) => exportTime(b) - exportTime(a) || byName(b, a));
    case "a-z":
      return out.sort((a, b) => a.name.localeCompare(b.name));
    case "z-a":
      return out.sort((a, b) => b.name.localeCompare(a.name));
  }
}

export function filterExports<T extends Pick<ExportRecordView, "name" | "aspect">>(
  rows: T[],
  filter: { aspect: ExportAspect | "all"; search: string },
): T[] {
  const q = filter.search.trim().toLowerCase();
  return rows.filter((r) => (filter.aspect === "all" || r.aspect === filter.aspect) && (!q || r.name.toLowerCase().includes(q)));
}

/** The aspects the rows actually have, in the canonical order — the filter's chips. */
export function aspectsPresent(rows: Array<Pick<ExportRecordView, "aspect">>): ExportAspect[] {
  const present = new Set(rows.map((r) => r.aspect));
  return EXPORT_ASPECTS.filter((a) => present.has(a));
}

/** The tab lists every export except cancelled ones (spec §A4). */
export function visibleInTab<T extends Pick<ExportRecordView, "status">>(rows: T[]): T[] {
  return rows.filter((r) => r.status !== "cancelled");
}

/** The resources panel's inner sort (components/resources/sort-utils.ts#SortOption). */
export type InnerSort = "created-desc" | "created-asc" | "a-z" | "z-a";

const INNER_TO_SORT: Record<InnerSort, ExportSort> = {
  "created-asc": "time-asc",
  "created-desc": "time-desc",
  "a-z": "a-z",
  "z-a": "z-a",
};

/** The resources folder: DONE exports, by the panel's inner sort (created ↔ queue time). */
export function exportsForTree(rows: ExportRecordView[], inner: InnerSort, search = ""): ExportRecordView[] {
  const q = search.trim().toLowerCase();
  const done = rows.filter((r) => r.status === "done" && (!q || r.name.toLowerCase().includes(q)));
  return sortExports(done, INNER_TO_SORT[inner]);
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** m:ss */
export function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Local date + time. */
export function formatExportTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** A render's percentage, or null before its first real tick / while it waits. */
export function activePercent(e: Pick<ExportRecordView, "progress">): number | null {
  const p = e.progress;
  if (!p || p.unit !== "%" || p.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)));
}

/** A queued/running export's one line: why it waits, or how far it is. */
export function activeLine(e: Pick<ExportRecordView, "status" | "progress" | "waiting">): string {
  if (e.waiting) return e.waiting.message;
  const p = e.progress;
  if (p && p.unit === "MB" && p.total > 0) return `Downloading Chromium… ${p.done}/${p.total} MB`;
  const pct = activePercent(e);
  if (pct != null) return `Exporting ${pct}%`;
  return e.status === "queued" ? "Queued" : "Starting";
}
